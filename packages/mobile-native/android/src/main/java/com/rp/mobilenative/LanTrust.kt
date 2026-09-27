package com.rp.mobilenative

import android.content.Context
import android.net.Uri
import com.facebook.react.modules.network.NetworkingModule
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.websocket.WebSocketModule
import java.io.ByteArrayInputStream
import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

/**
 * The restaurant's LAN certificate authority, pinned when the device pairs (ADR-0011, SEC-001,
 * SEC-010). Once pinned, a TLS connection to the paired server is trusted only if its certificate
 * chains to that CA; a user-installed or public CA cannot stand in for it. Other hosts keep the
 * phone's normal trust: the app talks only to its server, but development tools talk to others.
 *
 * Every React Native HTTP client goes through it: Expo's `fetch` and images take their client from
 * `OkHttpClientProvider`, XHR and WebSocket (Socket.io) apply the custom client builders. The pin
 * is kept in the app's private preferences and loaded as the app starts, before any request.
 */
object LanTrust {
  private const val PREFERENCES = "rp.lan-trust.v1"
  private const val KEY_CERTIFICATE = "certificate"
  private const val KEY_HOST = "host"

  /** The pinned CA (null when the stored one could not be read) and the host it is pinned for. */
  private class Pin(val certificate: X509Certificate?, val host: String, val trust: X509TrustManager)

  @Volatile private var pin: Pin? = null
  private var installed = false

  /** The phone's own trust store, for every host other than the paired server. */
  private val system: X509TrustManager by lazy { trustManagerFor(null) }

  /** The pinned CA for the paired server's host, the phone's trust store for any other host. */
  val trustManager: X509TrustManager =
    object : X509ExtendedTrustManager() {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) =
        system.checkClientTrusted(chain, authType)

      override fun checkClientTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        socket: Socket?,
      ) = system.checkClientTrusted(chain, authType)

      override fun checkClientTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        engine: SSLEngine?,
      ) = system.checkClientTrusted(chain, authType)

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
        forHost(null).checkServerTrusted(chain, authType)

      override fun checkServerTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        socket: Socket?,
      ) {
        val trust = forHost((socket as? SSLSocket)?.handshakeSession?.peerHost)
        if (trust is X509ExtendedTrustManager && socket != null) {
          trust.checkServerTrusted(chain, authType, socket)
        } else {
          trust.checkServerTrusted(chain, authType)
        }
      }

      override fun checkServerTrusted(
        chain: Array<X509Certificate>,
        authType: String,
        engine: SSLEngine?,
      ) {
        val trust = forHost(engine?.peerHost)
        if (trust is X509ExtendedTrustManager && engine != null) {
          trust.checkServerTrusted(chain, authType, engine)
        } else {
          trust.checkServerTrusted(chain, authType)
        }
      }

      override fun getAcceptedIssuers(): Array<X509Certificate> {
        val current = pin ?: return system.acceptedIssuers
        return current.certificate?.let { arrayOf(it) } ?: emptyArray()
      }
    }

  /** TLS sockets checked by [trustManager]; the pin can change without rebuilding clients. */
  val socketFactory: SSLSocketFactory by lazy {
    SSLContext.getInstance("TLS").apply { init(null, arrayOf(trustManager), null) }.socketFactory
  }

  /**
   * Loads the stored pin and makes React Native's HTTP clients use [trustManager]. Called once as
   * the application starts ([RpLanTrustPackage]); later calls do nothing.
   */
  @Synchronized
  fun install(context: Context) {
    if (installed) return
    installed = true
    val application = context.applicationContext
    load(application)
    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(application)
        .sslSocketFactory(socketFactory, trustManager)
        .build()
    }
    NetworkingModule.setCustomClientBuilder { builder ->
      builder.sslSocketFactory(socketFactory, trustManager)
    }
    WebSocketModule.setCustomClientBuilder { builder ->
      builder.sslSocketFactory(socketFactory, trustManager)
    }
  }

  /**
   * Pins the CA (PEM) for the server at `serverUrl` from now on and keeps it for the next start.
   * Returns its SHA-256 fingerprint, `AB:CD:…`, so the caller can check it once more.
   */
  @Synchronized
  fun pin(context: Context, certificatePem: String, serverUrl: String): String {
    val certificate = parseCertificate(certificatePem)
    require(certificate.basicConstraints >= 0) { "The server sent a certificate that is not a CA" }
    val host =
      Uri.parse(serverUrl).host?.lowercase()
        ?: throw IllegalArgumentException("There is no host in the server address")
    pin = Pin(certificate, host, trustOnly(certificate))
    preferences(context)
      .edit()
      .putString(KEY_CERTIFICATE, certificatePem)
      .putString(KEY_HOST, host)
      .commit()
    return fingerprint(certificate)
  }

  /** The pinned CA's fingerprint, or null when the device has none (or it could not be read). */
  fun pinnedFingerprint(): String? = pin?.certificate?.let { fingerprint(it) }

  /** Forgets the pin (the device was unpaired or revoked). */
  @Synchronized
  fun clear(context: Context) {
    pin = null
    preferences(context).edit().clear().commit()
  }

  /** Reads a PEM (or DER) X.509 certificate. */
  fun parseCertificate(certificatePem: String): X509Certificate =
    CertificateFactory.getInstance("X.509")
      .generateCertificate(ByteArrayInputStream(certificatePem.toByteArray(Charsets.US_ASCII)))
      as X509Certificate

  /** SHA-256 of the certificate's DER, as the server prints it: upper-case hex, `AB:CD:…`. */
  fun fingerprint(certificate: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString(":") {
      "%02X".format(it.toInt() and 0xff)
    }

  private fun forHost(host: String?): X509TrustManager {
    val current = pin ?: return system
    // An unknown host is held to the pin rather than let through on the phone's trust.
    return if (host == null || host.equals(current.host, ignoreCase = true)) current.trust else system
  }

  private fun load(context: Context) {
    val stored = preferences(context)
    val certificatePem = stored.getString(KEY_CERTIFICATE, null) ?: return
    val host = stored.getString(KEY_HOST, null) ?: return
    pin =
      try {
        val certificate = parseCertificate(certificatePem)
        Pin(certificate, host, trustOnly(certificate))
      } catch (e: Exception) {
        // A damaged pin trusts nothing: the server shows as unreachable until the device is paired
        // again, rather than falling back to the phone's trust store for it.
        Pin(null, host, rejectAll)
      }
  }

  /** A trust manager whose only anchor is the pinned CA. */
  private fun trustOnly(certificate: X509Certificate): X509TrustManager {
    val store =
      KeyStore.getInstance(KeyStore.getDefaultType()).apply {
        load(null, null)
        setCertificateEntry("rp-lan-ca", certificate)
      }
    return trustManagerFor(store)
  }

  private fun trustManagerFor(store: KeyStore?): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(store)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  private val rejectAll: X509TrustManager =
    object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("The pinned certificate authority could not be read")
      }

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        throw CertificateException("The pinned certificate authority could not be read")
      }

      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
}
