package com.rp.mobilenative

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

/**
 * Installs [LanTrust] as the application starts, so the pinned CA is in place before React Native
 * makes its first request (ADR-0011). Found by Expo autolinking (a `*Package.kt` importing
 * `expo.modules.core.interfaces.Package`).
 */
class RpLanTrustPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(
      object : ApplicationLifecycleListener {
        override fun onCreate(application: Application) {
          LanTrust.install(application)
        }
      },
    )
}
