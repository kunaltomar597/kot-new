package com.rp.mobilenative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

/**
 * Android's answer to an install of the app's new APK (P7-04e2). Not exported: only Android's
 * `PackageInstaller`, through the app's own pending intent, sends it.
 *
 * - Pending user action (a phone, or a tablet that does not own its device): opens Android's own
 *   confirmation, which the person answers.
 * - Success: nothing; Android replaces the app ([RpPackageReplacedReceiver]).
 * - Aborted: the person said no. Anything else: Android refused it, e.g. an APK signed with
 *   another key (UPD-007) or not enough space. Both reach JavaScript ([ApkInstalls.listen]).
 */
class RpApkInstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ApkInstalls.ACTION_RESULT) return
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = confirmation(intent)
        if (confirm == null) {
          ApkInstalls.deliver(mapOf("kind" to "failed", "message" to "Android did not ask to confirm"))
        } else {
          context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      PackageInstaller.STATUS_SUCCESS -> Unit
      PackageInstaller.STATUS_FAILURE_ABORTED -> ApkInstalls.deliver(mapOf("kind" to "cancelled"))
      else ->
        ApkInstalls.deliver(
          mapOf(
            "kind" to "failed",
            "message" to (intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $status"),
          ),
        )
    }
  }

  @Suppress("DEPRECATION")
  private fun confirmation(intent: Intent): Intent? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
    } else {
      intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
    }
}
