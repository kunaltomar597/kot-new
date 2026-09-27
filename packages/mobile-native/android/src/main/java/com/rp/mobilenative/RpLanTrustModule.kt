package com.rp.mobilenative

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject

/**
 * Pinning the restaurant's CA from JavaScript (ADR-0011, SEC-010): download it from a server
 * before trusting that server, pin it once its fingerprint checks out, and forget it on unpairing.
 * The trust itself is [LanTrust].
 */
class RpLanTrustModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RpLanTrust")

    /**
     * Downloads `GET <baseUrl>/api/v1/tls/ca` without checking the server's certificate, because
     * the device does not trust the server yet. Resolves `{ certificate, sha256 }`, the fingerprint
     * computed here from the certificate itself; nothing is trusted until the caller has compared
     * it with the pairing QR code or a person has.
     */
    AsyncFunction("fetchAuthority") { baseUrl: String, promise: Promise ->
      fetchAuthority(baseUrl, promise)
    }

    /** Pins the CA (PEM) for the server at `serverUrl`; resolves its fingerprint. */
    AsyncFunction("pin") { certificate: String, serverUrl: String ->
      LanTrust.pin(context(), certificate, serverUrl)
    }

    /** The pinned CA's fingerprint, or null. */
    AsyncFunction("pinned") {
      return@AsyncFunction LanTrust.pinnedFingerprint()
    }

    /** Forgets the pinned CA (the device was unpaired or revoked). */
    AsyncFunction("clear") {
      LanTrust.clear(context())
    }
  }

  private fun context(): Context =
    appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private fun fetchAuthority(baseUrl: String, promise: Promise) {
    val request =
      try {
        Request.Builder().url(baseUrl.trimEnd('/') + CA_PATH).get().build()
      } catch (e: IllegalArgumentException) {
        promise.reject("ERR_ADDRESS", "This is not a server address: $baseUrl", e)
        return
      }
    untrusted.newCall(request).enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          promise.reject("ERR_UNREACHABLE", "The server did not answer at $baseUrl", e)
        }

        override fun onResponse(call: Call, response: Response) {
          response.use {
            try {
              if (!it.isSuccessful) {
                promise.reject("ERR_NO_CA", "The server at $baseUrl has no LAN certificate", null)
                return
              }
              val pem = JSONObject(it.peekBody(MAX_BODY_BYTES).string()).getString("certificate")
              val certificate = LanTrust.parseCertificate(pem)
              if (certificate.basicConstraints < 0) {
                promise.reject("ERR_NO_CA", "The server at $baseUrl sent a certificate that is not a CA", null)
                return
              }
              promise.resolve(mapOf("certificate" to pem, "sha256" to LanTrust.fingerprint(certificate)))
            } catch (e: Exception) {
              promise.reject("ERR_NO_CA", "The server at $baseUrl sent no usable LAN certificate", e)
            }
          }
        }
      },
    )
  }

  private companion object {
    const val CA_PATH = "/api/v1/tls/ca"
    const val MAX_BODY_BYTES = 64L * 1024

    /**
     * Only for downloading the CA before pairing: it accepts any server certificate and host
     * name, because what it fetches is public and is trusted only after its fingerprint matches.
     * It never carries credentials; every other request goes through [LanTrust].
     */
    val untrusted: OkHttpClient by lazy {
      val acceptAny =
        object : X509TrustManager {
          override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit

          override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit

          override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
      val tls = SSLContext.getInstance("TLS").apply { init(null, arrayOf(acceptAny), null) }
      OkHttpClient.Builder()
        .sslSocketFactory(tls.socketFactory, acceptAny)
        .hostnameVerifier { _, _ -> true }
        .followRedirects(false)
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .callTimeout(8, TimeUnit.SECONDS)
        .build()
    }
  }
}
