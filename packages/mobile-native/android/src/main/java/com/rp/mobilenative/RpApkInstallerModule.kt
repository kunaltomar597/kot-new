package com.rp.mobilenative

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The in-app updater's native half (P7-04e2, WTR-001): the app's own version, whether it owns
 * its device (a kiosk tablet installs without asking), Android's "Install unknown apps" for it
 * on a phone, and [ApkInstalls]' download and install. How an install that did not happen ended
 * is sent as `onInstallResult`.
 */
class RpApkInstallerModule : Module() {
  private val deliver: (Map<String, Any?>) -> Unit = { result -> sendEvent(RESULT, result) }

  override fun definition() = ModuleDefinition {
    Name("RpApkInstaller")

    Events(RESULT)

    OnStartObserving(RESULT) { ApkInstalls.listen(deliver) }

    OnStopObserving(RESULT) { ApkInstalls.stopListening(deliver) }

    OnDestroy { ApkInstalls.stopListening(deliver) }

    /** `versionName` of the installed app, and whether it is its device's owner. */
    Function("state") {
      val context = context()
      mapOf(
        "versionName" to ownPackage(context).versionName,
        "deviceOwner" to
          (context.getSystemService(DevicePolicyManager::class.java)?.isDeviceOwnerApp(context.packageName) ?: false),
      )
    }

    /** Whether Android lets the app ask to install its update ("Install unknown apps"). */
    AsyncFunction("mayRequestInstall") {
      return@AsyncFunction context().packageManager.canRequestPackageInstalls()
    }

    /** Android's "Install unknown apps" page for this app, where a person allows it. */
    AsyncFunction("openInstallSettings") {
      val context = context()
      context.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    /** Downloads and checks the APK; resolves its path. */
    AsyncFunction("download") {
      url: String,
      headers: Map<String, String>,
      sha256: String,
      size: Double,
      version: String,
      promise: Promise ->
      ApkInstalls.download(context(), url, headers, sha256, size.toLong(), version, promise)
    }

    /** Hands a downloaded APK to Android's `PackageInstaller`. */
    AsyncFunction("install") { path: String -> ApkInstalls.install(context(), path) }
  }

  @Suppress("DEPRECATION")
  private fun ownPackage(context: Context): PackageInfo =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
      context.packageManager.getPackageInfo(context.packageName, 0)
    }

  private fun context(): Context =
    appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private companion object {
    const val RESULT = "onInstallResult"
  }
}
