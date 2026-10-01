package com.rp.mobilenative

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.WindowManager
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The table tablet's kiosk and health (P3-01b, TAB-001, TAB-015, SEC-010).
 *
 * Kiosk: Android lock-task mode. When MDM (or `adb shell dpm set-device-owner` in testing) has made
 * the app device owner, [enter] allows its own package to lock, takes the lock screen and status
 * bar away and keeps the screen on while plugged in, then locks without asking: diners cannot leave
 * the app. Without device owner, Android pins the screen after asking the person holding the tablet
 * (the state says which). Staff leave with [exit] after a manager's PIN.
 *
 * Health: battery level, charging, the kind of network and the Wi-Fi signal, read on demand with no
 * extra permission (the network state is a normal permission).
 */
class RpKioskModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RpKiosk")

    /** `mode`: NONE, LOCKED (full kiosk) or PINNED (screen pinning); and what the device allows. */
    Function("state") {
      val context = context()
      mapOf(
        "mode" to mode(context),
        "deviceOwner" to policies(context).isDeviceOwnerApp(context.packageName),
        "permitted" to policies(context).isLockTaskPermitted(context.packageName),
      )
    }

    /** Locks the app on screen; returns the mode it is in afterwards. */
    AsyncFunction("enter") {
      val context = context()
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      val policies = policies(context)
      if (policies.isDeviceOwnerApp(context.packageName)) {
        val admin = ComponentName(context, RpDeviceAdminReceiver::class.java)
        policies.setLockTaskPackages(admin, arrayOf(context.packageName))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          policies.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
        }
        policies.setKeyguardDisabled(admin, true)
        policies.setStatusBarDisabled(admin, true)
        policies.setGlobalSetting(
          admin,
          Settings.Global.STAY_ON_WHILE_PLUGGED_IN,
          (BatteryManager.BATTERY_PLUGGED_AC or
              BatteryManager.BATTERY_PLUGGED_USB or
              BatteryManager.BATTERY_PLUGGED_WIRELESS)
            .toString(),
        )
      }
      if (mode(context) == "NONE") activity.startLockTask()
      mode(context)
    }
      .runOnQueue(Queues.MAIN)

    /** Leaves lock-task mode (after a manager's PIN, checked by the server). */
    AsyncFunction("exit") {
      val context = context()
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      if (mode(context) != "NONE") activity.stopLockTask()
      if (policies(context).isDeviceOwnerApp(context.packageName)) {
        val admin = ComponentName(context, RpDeviceAdminReceiver::class.java)
        policies(context).setStatusBarDisabled(admin, false)
      }
      mode(context)
    }
      .runOnQueue(Queues.MAIN)

    /** The screen stays on while the app shows (a tablet on the table never sleeps). */
    AsyncFunction("keepScreenOn") { on: Boolean ->
      val window = appContext.currentActivity?.window ?: throw Exceptions.MissingActivity()
      if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
      .runOnQueue(Queues.MAIN)

    /** Battery, charging, network and Wi-Fi signal (TAB-015). */
    Function("health") {
      val context = context()
      val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
      val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
      val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
      val connectivity = context.getSystemService(ConnectivityManager::class.java)
      val capabilities = connectivity?.getNetworkCapabilities(connectivity.activeNetwork)
      val network =
        when {
          capabilities == null -> "NONE"
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ETHERNET"
          capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
          else -> "OTHER"
        }
      val signal =
        if (
          network == "WIFI" &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            capabilities != null &&
            capabilities.signalStrength != NetworkCapabilities.SIGNAL_STRENGTH_UNSPECIFIED
        ) {
          capabilities.signalStrength
        } else {
          null
        }
      mapOf(
        "batteryPercent" to if (level >= 0 && scale > 0) level * 100 / scale else null,
        "charging" to if (battery == null) null else plugged != 0,
        "network" to network,
        "rssi" to signal,
      )
    }

    /** "Locate" from the dashboard (MGR-006): a tone on the alarm stream for a few seconds. */
    AsyncFunction("locateTone") { durationMs: Int ->
      val tone = ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME)
      tone.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, durationMs)
      Handler(Looper.getMainLooper()).postDelayed({ tone.release() }, durationMs + 200L)
    }
  }

  private fun context(): Context =
    appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun policies(context: Context): DevicePolicyManager =
    context.getSystemService(DevicePolicyManager::class.java)

  private fun mode(context: Context): String =
    when (context.getSystemService(ActivityManager::class.java).lockTaskModeState) {
      ActivityManager.LOCK_TASK_MODE_LOCKED -> "LOCKED"
      ActivityManager.LOCK_TASK_MODE_PINNED -> "PINNED"
      else -> "NONE"
    }
}
