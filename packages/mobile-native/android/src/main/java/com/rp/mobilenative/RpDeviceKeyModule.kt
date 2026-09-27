package com.rp.mobilenative

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * The device key in the Android Keystore (AUTH-007, SEC-006, SEC-010): an ECDSA P-256 key pair
 * whose private half is created inside the Keystore (StrongBox when the phone has it) and can
 * never be read out. JavaScript only ever sees the public key and signatures.
 */
class RpDeviceKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RpDeviceKey")

    /** The public key (SPKI, DER, base64) of the key under `alias`, or null when there is none. */
    AsyncFunction("publicKey") { alias: String ->
      keyStore().getCertificate(alias)?.publicKey?.encoded?.let { encode(it) }
    }

    /** Creates a new key under `alias`, replacing any old one, and returns its public key. */
    AsyncFunction("create") { alias: String ->
      val store = keyStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
      val pair =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          try {
            generate(alias, strongBox = true)
          } catch (e: ProviderException) {
            // StrongBoxUnavailableException is a ProviderException: fall back to the TEE.
            generate(alias, strongBox = false)
          }
        } else {
          generate(alias, strongBox = false)
        }
      encode(pair.public.encoded)
    }

    /** Signs the UTF-8 message with SHA-256; the signature is DER (ASN.1), base64. */
    AsyncFunction("sign") { alias: String, message: String ->
      val entry =
        keyStore().getEntry(alias, null) as? KeyStore.PrivateKeyEntry
          ?: throw IllegalStateException("There is no device key on this device")
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(entry.privateKey)
      signature.update(message.toByteArray(Charsets.UTF_8))
      encode(signature.sign())
    }

    /** Deletes the key (the device was unpaired or revoked). */
    AsyncFunction("remove") { alias: String ->
      val store = keyStore()
      if (store.containsAlias(alias)) store.deleteEntry(alias)
    }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  private fun generate(alias: String, strongBox: Boolean): java.security.KeyPair {
    val builder =
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(true)
    }
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
    generator.initialize(builder.build())
    return generator.generateKeyPair()
  }

  private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

  private companion object {
    const val PROVIDER = "AndroidKeyStore"
  }
}
