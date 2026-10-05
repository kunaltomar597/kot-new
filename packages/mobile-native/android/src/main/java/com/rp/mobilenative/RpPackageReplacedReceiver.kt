package com.rp.mobilenative

import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The app was replaced by its new APK (P7-04e2). The downloaded APK is removed. A table tablet
 * that owns its device (TAB-001) opens the app again at once, so it is back in kiosk mode on its
 * table; Android lets a device owner start its activity from the background. A phone's person
 * opens it from Android's "App installed" screen.
 */
class RpPackageReplacedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    ApkInstalls.clearDownloads(context)
    val policies = context.getSystemService(DevicePolicyManager::class.java) ?: return
    if (!policies.isDeviceOwnerApp(context.packageName)) return
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
