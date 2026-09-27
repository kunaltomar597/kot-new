package com.rp.mobilenative

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * What a waiter phone shows for its holder's alerts (P2-06b, WTR-005): one notification per open
 * alert on a high-importance channel, with sound, vibration and an Acknowledge action, shown on the
 * lock screen and alerting again on each repeat. While the app is in the foreground its banner
 * shows the alert, so the phone only rings and vibrates. Also the quiet notification of
 * [RpAlertService], which keeps the phone listening. The words come from JavaScript (NFR-L02).
 */
object AlertNotifications {
  const val ALERTS_CHANNEL = "rp.alerts.v1"
  const val LISTENING_CHANNEL = "rp.listening.v1"

  /** The service's notification. An alert's is [ALERT_ID] under its own tag. */
  const val LISTENING_ID = 1
  private const val ALERT_ID = 2
  private const val TAG_PREFIX = "rp.alert:"
  private const val PREFERENCES = "rp.alerts.v1"
  private const val LOG_TAG = "RpAlerts"

  /** Three long buzzes, hard to miss in a pocket. */
  private val VIBRATION = longArrayOf(0, 400, 200, 400, 200, 400)

  private val SOUND: AudioAttributes =
    AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

  /** The words of the service's notification and of the two channels. */
  class Listening(
    val title: String,
    val text: String,
    val alertsChannel: String,
    val listeningChannel: String,
  )

  /** One alert as JavaScript words it (`describeAlert`). */
  class Alert(
    val id: String,
    val title: String,
    val text: String,
    val acknowledge: String,
    val postedAt: Long,
  )

  /** Kept for a restart of the service by Android after its process was stopped. */
  fun saveListening(context: Context, listening: Listening) {
    preferences(context)
      .edit()
      .putString(KEY_TITLE, listening.title)
      .putString(KEY_TEXT, listening.text)
      .putString(KEY_ALERTS_CHANNEL, listening.alertsChannel)
      .putString(KEY_LISTENING_CHANNEL, listening.listeningChannel)
      .apply()
  }

  /** What the service shows while the phone listens, or null when nobody holds it. */
  fun listening(context: Context): Listening? {
    val saved = preferences(context)
    return Listening(
      title = saved.getString(KEY_TITLE, null) ?: return null,
      text = saved.getString(KEY_TEXT, null) ?: return null,
      alertsChannel = saved.getString(KEY_ALERTS_CHANNEL, null) ?: return null,
      listeningChannel = saved.getString(KEY_LISTENING_CHANNEL, null) ?: return null,
    )
  }

  fun forgetListening(context: Context) {
    preferences(context).edit().clear().apply()
  }

  /**
   * The alerts channel rings and vibrates and shows on the lock screen; the service's channel is
   * silent. Creating them again only renames them: the person's own settings for them stay.
   */
  fun ensureChannels(context: Context, listening: Listening) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val alerts =
      NotificationChannel(ALERTS_CHANNEL, listening.alertsChannel, NotificationManager.IMPORTANCE_HIGH)
        .apply {
          enableVibration(true)
          vibrationPattern = VIBRATION
          setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION), SOUND)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
    val service =
      NotificationChannel(
          LISTENING_CHANNEL,
          listening.listeningChannel,
          NotificationManager.IMPORTANCE_LOW,
        )
        .apply {
          enableVibration(false)
          setSound(null, null)
          setShowBadge(false)
        }
    manager.createNotificationChannels(listOf(alerts, service))
  }

  /** The service's ongoing notification: who the phone listens for; a tap opens the app. */
  fun listeningNotification(context: Context, listening: Listening): Notification =
    NotificationCompat.Builder(context, LISTENING_CHANNEL)
      .setSmallIcon(R.drawable.rp_alert_bell)
      .setContentTitle(listening.title)
      .setContentText(listening.text)
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(openApp(context))
      .build()

  /**
   * An alert that is new or came back (a repeat): a notification in the background (posting it
   * again alerts again), and only the ring and the vibration in the foreground, where the banner
   * shows it. With notifications turned off the phone still rings, so the alert is not missed.
   */
  fun announce(context: Context, alert: Alert) {
    if (!inForeground() && enabled(context)) {
      post(context, alert)
    } else {
      ring(context)
    }
  }

  /** The alert was acknowledged or cleared, anywhere. */
  fun dismiss(context: Context, alertId: String) {
    NotificationManagerCompat.from(context).cancel(TAG_PREFIX + alertId, ALERT_ID)
  }

  /** Nobody to alert any more: every alert notification goes. */
  fun dismissAll(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    for (shown in manager.activeNotifications) {
      val tag = shown.tag ?: continue
      if (tag.startsWith(TAG_PREFIX)) manager.cancel(tag, shown.id)
    }
  }

  /**
   * Whether alert notifications can show: on Android 13 and later only with `POST_NOTIFICATIONS`,
   * and never when the person turned them or the alerts channel off.
   */
  fun enabled(context: Context): Boolean {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
          PackageManager.PERMISSION_GRANTED
    ) {
      return false
    }
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return false
    val channel = manager.getNotificationChannel(ALERTS_CHANNEL)
    return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
  }

  @SuppressLint("MissingPermission") // `announce` checks `enabled` first.
  private fun post(context: Context, alert: Alert) {
    val builder =
      NotificationCompat.Builder(context, ALERTS_CHANNEL)
        .setSmallIcon(R.drawable.rp_alert_bell)
        .setContentTitle(alert.title)
        .setCategory(NotificationCompat.CATEGORY_REMINDER)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setWhen(alert.postedAt)
        .setShowWhen(true)
        .setAutoCancel(false)
        .setContentIntent(openApp(context))
        .addAction(
          NotificationCompat.Action.Builder(
              R.drawable.rp_alert_bell,
              alert.acknowledge,
              acknowledgeIntent(context, alert.id),
            )
            .build()
        )
    if (alert.text.isNotEmpty()) {
      builder.setContentText(alert.text).setStyle(NotificationCompat.BigTextStyle().bigText(alert.text))
    }
    NotificationManagerCompat.from(context).notify(TAG_PREFIX + alert.id, ALERT_ID, builder.build())
  }

  /** The app's own screen is on top: the banner shows the alert. */
  private fun inForeground(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private var ringtone: Ringtone? = null

  /** The notification sound and the vibration, as the phone's ringer mode allows. */
  private fun ring(context: Context) {
    Handler(Looper.getMainLooper()).post {
      try {
        val mode =
          context.getSystemService(AudioManager::class.java)?.ringerMode
            ?: AudioManager.RINGER_MODE_NORMAL
        if (mode == AudioManager.RINGER_MODE_SILENT) return@post
        if (mode == AudioManager.RINGER_MODE_NORMAL) {
          ringtone?.stop()
          // Held until the next ring: a ringtone that is collected stops playing.
          ringtone =
            RingtoneManager.getRingtone(
                context,
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
              )
              ?.apply {
                audioAttributes = SOUND
                play()
              }
        }
        vibrator(context)?.vibrate(VibrationEffect.createWaveform(VIBRATION, -1), SOUND)
      } catch (e: RuntimeException) {
        // A phone without a ringtone or a vibrator still shows the banner.
        Log.w(LOG_TAG, "Could not ring for an alert", e)
      }
    }
  }

  private fun vibrator(context: Context): Vibrator? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
      context.getSystemService(Vibrator::class.java)
    }

  /** Opens the app where it was, like its launcher icon. */
  private fun openApp(context: Context): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    return PendingIntent.getActivity(
      context,
      0,
      launch,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  /** One pending intent per alert: the data URI keeps them apart, the extras do not. */
  private fun acknowledgeIntent(context: Context, alertId: String): PendingIntent {
    val intent =
      Intent(context, RpAlertActionReceiver::class.java)
        .setAction(RpAlertActionReceiver.ACKNOWLEDGE)
        .setData(Uri.fromParts(ALERT_SCHEME, alertId, null))
        .putExtra(RpAlertActionReceiver.EXTRA_ALERT_ID, alertId)
    return PendingIntent.getBroadcast(
      context,
      0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  private const val ALERT_SCHEME = "rp-alert"
  private const val KEY_TITLE = "title"
  private const val KEY_TEXT = "text"
  private const val KEY_ALERTS_CHANNEL = "alertsChannel"
  private const val KEY_LISTENING_CHANNEL = "listeningChannel"
}
