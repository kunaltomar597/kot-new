package com.rp.mobilenative

import android.app.admin.DeviceAdminReceiver

/**
 * The device-admin component that makes the table tablet's app device owner (P3-01b, TAB-001):
 * MDM provisions it, or in testing `adb shell dpm set-device-owner
 * in.rp.tablet.dev/com.rp.mobilenative.RpDeviceAdminReceiver`. It asks for no admin policies of
 * its own; being device owner is what lets [RpKioskModule] lock the app on screen without asking.
 * On a waiter phone it is never activated.
 */
class RpDeviceAdminReceiver : DeviceAdminReceiver()
