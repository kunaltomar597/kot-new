package com.rp.mobilenative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Acknowledge pressed on an alert's notification (P2-06b, NTF-004): the notification goes at once
 * and JavaScript acknowledges the alert as the phone's holder, like the pager's button. Not
 * exported: only the notifications this app posts reach it.
 */
class RpAlertActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACKNOWLEDGE) return
    val alertId = intent.getStringExtra(EXTRA_ALERT_ID) ?: return
    AlertNotifications.dismiss(context, alertId)
    AlertActions.acknowledged(context, alertId)
  }

  companion object {
    const val ACKNOWLEDGE = "com.rp.mobilenative.alerts.ACKNOWLEDGE"
    const val EXTRA_ALERT_ID = "alertId"
  }
}

/**
 * Acknowledgements pressed on notifications, on their way to JavaScript. One pressed while
 * JavaScript is not listening (React Native is starting, or the app was stopped) waits in the
 * app's private preferences until it listens again.
 */
object AlertActions {
  private const val PREFERENCES = "rp.alert-actions.v1"
  private const val KEY_WAITING = "acknowledge"

  private var listener: ((String) -> Unit)? = null

  @Synchronized
  fun acknowledged(context: Context, alertId: String) {
    val deliver = listener
    if (deliver != null) {
      deliver(alertId)
      return
    }
    val saved = preferences(context)
    val waiting = saved.getStringSet(KEY_WAITING, null).orEmpty() + alertId
    saved.edit().putStringSet(KEY_WAITING, waiting).apply()
  }

  /** JavaScript listens: what was pressed meanwhile is delivered first. */
  @Synchronized
  fun listen(context: Context, deliver: (String) -> Unit) {
    listener = deliver
    val saved = preferences(context)
    val waiting = saved.getStringSet(KEY_WAITING, null).orEmpty().toList()
    if (waiting.isEmpty()) return
    saved.edit().remove(KEY_WAITING).apply()
    waiting.forEach(deliver)
  }

  @Synchronized
  fun stopListening(deliver: (String) -> Unit) {
    if (listener === deliver) listener = null
  }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
}
