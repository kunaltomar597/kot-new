package com.rp.mobilenative

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Keeps a waiter phone listening for its holder's alerts with the screen off or the app closed
 * (P2-06b, WTR-005). A foreground service keeps the app's process, and in Doze its network and
 * wake lock. It runs a headless JavaScript task that never finishes on its own, so React Native
 * keeps running JavaScript timers with no screen (Socket.io's heartbeats and reconnects need
 * them), and [startTask] holds a partial wake lock until the service is destroyed. Android 14's
 * `specialUse` type: a `dataSync` service is stopped after 6 hours, and a shift is longer.
 *
 * JavaScript starts it when the phone has a holder and stops it when nobody holds it any more;
 * the tasks never stop it. If Android stops the process, it restarts the service with the saved
 * words, and the task starts JavaScript again, which reconnects (`RpAlertKeepAlive`).
 */
class RpAlertService : HeadlessJsTaskService() {
  /** The keep-alive tasks started here, finished when the service stops. */
  private val keepAlive = CopyOnWriteArraySet<Int>()

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      shutDown()
      return START_NOT_STICKY
    }
    // Null after the holder signed out while Android was restarting the service.
    val listening = AlertNotifications.listening(this)
    if (listening == null) {
      shutDown()
      return START_NOT_STICKY
    }
    try {
      AlertNotifications.ensureChannels(this, listening)
      val notification = AlertNotifications.listeningNotification(this, listening)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          AlertNotifications.LISTENING_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
      } else {
        startForeground(AlertNotifications.LISTENING_ID, notification)
      }
    } catch (e: RuntimeException) {
      // Android 12 and later can refuse a restart in the background: the app alerts while open.
      Log.w(TAG, "The alert service could not run in the foreground", e)
      shutDown()
      return START_NOT_STICKY
    }
    running = true
    keepJavaScriptRunning()
    return START_STICKY
  }

  /**
   * Starts the keep-alive task in the current React instance (starting React Native if it is not
   * running) unless one runs there already, as after a reload of JavaScript.
   */
  private fun keepJavaScriptRunning() {
    val context = reactContext
    if (context != null && HeadlessJsTaskContext.getInstance(context).hasActiveTasks()) return
    startTask(
      HeadlessJsTaskConfig(
        KEEP_ALIVE_TASK,
        Arguments.createMap(),
        0, // No timeout: it runs until the service stops.
        true, // It also starts while the app is on screen, as at sign-in.
      )
    )
  }

  override fun onHeadlessJsTaskStart(taskId: Int) {
    keepAlive.add(taskId)
  }

  /** A task that ends does not stop the service: only [stop] does. */
  override fun onHeadlessJsTaskFinish(taskId: Int) {
    keepAlive.remove(taskId)
  }

  override fun onDestroy() {
    running = false
    finishKeepAlive()
    super.onDestroy()
  }

  private fun shutDown() {
    running = false
    finishKeepAlive()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  /** Lets React Native pause JavaScript timers again while the app is in the background. */
  private fun finishKeepAlive() {
    val context = reactContext ?: return
    val tasks = HeadlessJsTaskContext.getInstance(context)
    for (taskId in keepAlive) tasks.finishTask(taskId)
    keepAlive.clear()
  }

  companion object {
    /** The task JavaScript registers with `AppRegistry.registerHeadlessTask`. */
    const val KEEP_ALIVE_TASK = "RpAlertKeepAlive"
    private const val ACTION_STOP = "com.rp.mobilenative.alerts.STOP"
    private const val TAG = "RpAlertService"

    /** Running in the foreground. */
    @Volatile private var running = false

    /** Asked to start and not stopped since. */
    @Volatile private var wanted = false

    /**
     * Starts listening, or updates the notification of the service already listening. Android 12
     * and later refuse a start while the app is in the background: it is started at sign-in.
     */
    fun start(context: Context) {
      val intent = Intent(context, RpAlertService::class.java)
      if (running) {
        context.startService(intent)
        return
      }
      wanted = true
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (e: IllegalStateException) {
        wanted = false
        throw e
      }
    }

    /**
     * Stops listening. Sent to the service rather than stopping it, so a start still on its way
     * reaches `startForeground` first (stopping it before that would crash the app).
     */
    fun stop(context: Context) {
      if (!running && !wanted) return
      wanted = false
      try {
        context.startService(Intent(context, RpAlertService::class.java).setAction(ACTION_STOP))
      } catch (e: IllegalStateException) {
        context.stopService(Intent(context, RpAlertService::class.java))
      }
    }
  }
}
