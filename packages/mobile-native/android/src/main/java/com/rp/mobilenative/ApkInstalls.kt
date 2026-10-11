package com.rp.mobilenative

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.Promise
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * New APKs of the app from the restaurant PC (P7-04e2, WTR-001, UPD-001, UPD-007).
 *
 * [download] fetches the APK the PC described over the pinned LAN CA ([LanTrust]) with the
 * device's token, and keeps it only if its size and SHA-256 are the PC's and Android reads it as
 * this same app at the expected version. [install] hands it to Android's `PackageInstaller`:
 * Android installs it only over an app signed with the same key. A device-owner tablet installs
 * without anyone asked; a phone shows Android's confirmation ([RpApkInstallReceiver]). How an
 * install that did not happen ended reaches JavaScript through [listen].
 */
object ApkInstalls {
  private const val FOLDER = "rp-apk"
  const val ACTION_RESULT = "com.rp.mobilenative.APK_INSTALL_RESULT"

  private val listeners = mutableSetOf<(Map<String, Any?>) -> Unit>()
  /** An answer that came while nobody listened, delivered to the next listener. */
  private var pending: Map<String, Any?>? = null

  /** The PC's own server, trusted through the pinned CA only; no redirects anywhere else. */
  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .sslSocketFactory(LanTrust.socketFactory, LanTrust.trustManager)
      .followRedirects(false)
      .followSslRedirects(false)
      .connectTimeout(5, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .build()
  }

  fun downloadsDir(context: Context): File = File(context.cacheDir, FOLDER)

  /** Removes downloaded APKs: before a new download, and once the app was replaced. */
  fun clearDownloads(context: Context) {
    downloadsDir(context).listFiles()?.forEach { it.delete() }
  }

  /** Resolves the path of the checked APK; rejects (and deletes it) when anything differs. */
  fun download(
    context: Context,
    url: String,
    headers: Map<String, String>,
    sha256: String,
    size: Long,
    version: String,
    promise: Promise,
  ) {
    val request =
      try {
        val builder = Request.Builder().url(url).get()
        for ((name, value) in headers) builder.header(name, value)
        builder.build()
      } catch (e: IllegalArgumentException) {
        promise.reject("ERR_ADDRESS", "This is not a server address: $url", e)
        return
      }
    val dir = downloadsDir(context)
    clearDownloads(context)
    dir.mkdirs()
    val partial = File(dir, "$sha256.part")
    val target = File(dir, "$sha256.apk")
    client.newCall(request).enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          partial.delete()
          promise.reject("ERR_UNREACHABLE", "The restaurant PC did not send the update", e)
        }

        override fun onResponse(call: Call, response: Response) {
          response.use {
            try {
              if (!it.isSuccessful) {
                promise.reject("ERR_DOWNLOAD", "The restaurant PC answered ${it.code}", null)
                return
              }
              val digest = MessageDigest.getInstance("SHA-256")
              var written = 0L
              it.body!!.byteStream().use { input ->
                partial.outputStream().use { output ->
                  val buffer = ByteArray(64 * 1024)
                  while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    written += read
                    if (written > size) throw IOException("The update is larger than the PC said")
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                  }
                }
              }
              val hex = digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
              if (written != size || hex != sha256) {
                throw IOException("The update does not match the SHA-256 the PC gave")
              }
              checkPackage(context, partial, version)
              if (!partial.renameTo(target)) throw IOException("The update could not be kept")
              promise.resolve(target.absolutePath)
            } catch (e: Exception) {
              partial.delete()
              promise.reject("ERR_CHECK", e.message ?: "The update failed its check", e)
            }
          }
        }
      },
    )
  }

  /** The APK is this same app (package name) at the version the PC described. */
  private fun checkPackage(context: Context, apk: File, version: String) {
    val archive =
      archiveInfo(context.packageManager, apk.absolutePath)
        ?: throw IOException("The update is not an Android app")
    if (archive.packageName != context.packageName) {
      throw IOException("The update is another app (${archive.packageName})")
    }
    if (archive.versionName != version) {
      throw IOException("The update is version ${archive.versionName}, not $version")
    }
  }

  @Suppress("DEPRECATION")
  private fun archiveInfo(manager: PackageManager, path: String): PackageInfo? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      manager.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(0))
    } else {
      manager.getPackageArchiveInfo(path, 0)
    }

  /**
   * Hands a checked APK (one [download] kept) to Android. The result arrives at
   * [RpApkInstallReceiver]; on success Android replaces the app, which stops it.
   */
  fun install(context: Context, path: String) {
    val apk = File(path).canonicalFile
    if (apk.parentFile != downloadsDir(context).canonicalFile || !apk.name.endsWith(".apk")) {
      throw IOException("Only an update this app downloaded is installed")
    }
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(context.packageName)
    params.setSize(apk.length())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // Android 12+: an app may update itself without asking when it installed itself before;
      // otherwise Android still asks, which is what a phone does anyway.
      params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }
    val sessionId = installer.createSession(params)
    try {
      installer.openSession(sessionId).use { session ->
        apk.inputStream().use { input ->
          session.openWrite("update.apk", 0, apk.length()).use { output ->
            input.copyTo(output)
            session.fsync(output)
          }
        }
        val intent =
          Intent(context, RpApkInstallReceiver::class.java)
            .setAction(ACTION_RESULT)
            .setPackage(context.packageName)
        // Mutable: Android adds the result to it. Explicit: only the app's own receiver gets it.
        val mutable =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or mutable
        val result = PendingIntent.getBroadcast(context, sessionId, intent, flags)
        session.commit(result.intentSender)
      }
    } catch (e: Exception) {
      installer.abandonSession(sessionId)
      throw e
    }
  }

  @Synchronized
  fun listen(listener: (Map<String, Any?>) -> Unit) {
    listeners.add(listener)
    pending?.let {
      pending = null
      listener(it)
    }
  }

  @Synchronized
  fun stopListening(listener: (Map<String, Any?>) -> Unit) {
    listeners.remove(listener)
  }

  /** How an install that did not happen ended: `cancelled`, or `failed` with Android's message. */
  @Synchronized
  fun deliver(result: Map<String, Any?>) {
    if (listeners.isEmpty()) pending = result else listeners.toList().forEach { it(result) }
  }
}
