package com.rp.mobilenative

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** The words of the service's notification and of the channels, from JavaScript (NFR-L02). */
class ListeningNotice : Record {
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val alertsChannel: String = ""
  @Field val listeningChannel: String = ""
}

/** One alert as JavaScript words it. `postedAt` is when it was raised, in epoch milliseconds. */
class AlertNotice : Record {
  @Field val id: String = ""
  @Field val title: String = ""
  @Field val text: String = ""
  @Field val acknowledge: String = ""
  @Field val postedAt: Double = 0.0
}

/**
 * The waiter phone's alerts outside the app's screen (P2-06b, WTR-005, WTR-006): [RpAlertService]
 * while the phone has a holder, the notifications of [AlertNotifications], and Acknowledge
 * pressed on one, sent to JavaScript as `onAcknowledge`.
 */
class RpAlertsModule : Module() {
  private val deliver: (String) -> Unit = { alertId ->
    sendEvent(ACKNOWLEDGED, mapOf("alertId" to alertId))
  }

  override fun definition() = ModuleDefinition {
    Name("RpAlerts")

    Events(ACKNOWLEDGED)

    OnStartObserving(ACKNOWLEDGED) { AlertActions.listen(context(), deliver) }

    OnStopObserving(ACKNOWLEDGED) { AlertActions.stopListening(deliver) }

    OnDestroy { AlertActions.stopListening(deliver) }

    /** The phone has a holder: listen for their alerts, also with the screen off. */
    AsyncFunction("start") { notice: ListeningNotice ->
      val context = context()
      val listening =
        AlertNotifications.Listening(
          notice.title,
          notice.text,
          notice.alertsChannel,
          notice.listeningChannel,
        )
      AlertNotifications.saveListening(context, listening)
      AlertNotifications.ensureChannels(context, listening)
      try {
        RpAlertService.start(context)
      } catch (e: IllegalStateException) {
        throw BackgroundStartException(e)
      }
    }

    /** Nobody to alert any more: stop listening and take every alert notification off. */
    AsyncFunction("stop") {
      val context = context()
      AlertNotifications.forgetListening(context)
      RpAlertService.stop(context)
      AlertNotifications.dismissAll(context)
    }

    AsyncFunction("announce") { notice: AlertNotice ->
      AlertNotifications.announce(
        context(),
        AlertNotifications.Alert(
          notice.id,
          notice.title,
          notice.text,
          notice.acknowledge,
          notice.postedAt.toLong(),
        ),
      )
    }

    AsyncFunction("dismiss") { alertId: String -> AlertNotifications.dismiss(context(), alertId) }

    AsyncFunction("notificationsEnabled") {
      return@AsyncFunction AlertNotifications.enabled(context())
    }

    /**
     * Asks for `POST_NOTIFICATIONS` (Android 13 and later) unless it was given; resolves whether
     * alert notifications can show. Android shows its question at most twice.
     */
    AsyncFunction("requestPermission") { promise: Promise ->
      val context = context()
      val permissions = appContext.permissions
      if (
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
          permissions == null ||
          AlertNotifications.enabled(context)
      ) {
        promise.resolve(AlertNotifications.enabled(context))
        return@AsyncFunction
      }
      permissions.askForPermissions(
        PermissionsResponseListener { promise.resolve(AlertNotifications.enabled(context)) },
        Manifest.permission.POST_NOTIFICATIONS,
      )
    }

    /** Opens the app's notification settings, where a person can turn them back on. */
    AsyncFunction("openSettings") {
      val context = context()
      val intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      (appContext.currentActivity ?: context).startActivity(intent)
    }
  }

  private fun context(): Context =
    appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private class BackgroundStartException(cause: Throwable) :
    CodedException(
      "ERR_BACKGROUND_START",
      "Android did not let the alerts start while the app was in the background",
      cause,
    )

  private companion object {
    const val ACKNOWLEDGED = "onAcknowledge"
  }
}
