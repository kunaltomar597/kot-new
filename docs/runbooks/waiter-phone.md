# Waiter phones: alerts that ring in the pocket

For the installer, support and the restaurant's manager. Background: WTR-005, WTR-006, NTF-004 to
NTF-007, P2-06a and P2-06b.

A waiter phone rings for the alerts of the person who last signed in on it, like their pager: food
ready, a new order to approve, a bill asked for, a manager's message. It keeps ringing with the
screen off, the phone locked or the app closed from the recents list, until that person signs out
on the phone or signs in on another one. An inactivity sign-out does not stop the alerts.

## How to tell it is listening

While someone holds the phone, Android shows a quiet notification "Alerts for Ravi" (the name of
the person). It goes when they sign out on the phone. If it is missing while someone is signed in,
the phone is not listening in the background: work through the setup below.

Each alert is its own notification, on the lock screen too, with Acknowledge. Acknowledging there
or in the app stops the pager's reminders and tells the managers' screens. An alert that is not
acknowledged rings again at each reminder.

## Setting a phone up

Do this once per phone, before its first shift, then run the check at the end.

1. Notifications: Android 13 and later ask when someone first signs in; answer Allow. If it was
   refused, the app's home shows "Notifications are off" with a Turn on button, or go to
   Settings > Apps > RP Waiter > Notifications and turn them on, including the "Alerts" category.
2. Battery: Settings > Apps > RP Waiter > Battery > Unrestricted (the name differs by maker; it may
   be "App battery usage", "Background usage limits" or "Battery optimisation: Don't optimise").
   Many phones sold in India stop background apps unless told not to:
   - Xiaomi, Redmi, POCO: App info > Autostart on; Battery saver > No restrictions; in the recents
     list, lock the app (long press, the lock icon).
   - Samsung: Settings > Battery > Background usage limits > Never sleeping apps: add RP Waiter.
   - Oppo, Realme, OnePlus, Vivo: App info > Battery: Allow background activity and Allow auto
     launch (or "High background power consumption").

   With a device management (MDM) policy, add the app to the battery optimisation allow list
   instead.

3. Do Not Disturb: keep it off during service, or allow RP Waiter's "Alerts" category to override
   it (Settings > Apps > RP Waiter > Notifications > Alerts > Override Do Not Disturb).
4. Sound: the alerts use the phone's notification sound and volume. A phone on silent vibrates
   only, and on total silence does neither: keep the ringer on.
5. Wi-Fi: the phone must stay on the staff Wi-Fi (SEC-008). On older phones, set Wi-Fi > Advanced >
   Keep Wi-Fi on during sleep: Always.

The phone stays awake while it listens, so it uses more battery than an idle phone: charge it
between shifts. The pager is still the waiter's main alert; if both the pager and the phone are
unreachable, the managers get the alert at once (NTF-007).

## Check it works

1. Sign in as a waiter who has a table, then lock the phone and put it away.
2. On the kitchen screen, mark one of that table's dishes Ready.
3. Within a couple of seconds the phone rings and vibrates, and the lock screen shows "Table 5 ·
   Food ready" (with the table's label) and the dish. The waiter's pager buzzes too.
4. Press Acknowledge on the notification: it goes, and the pager stops reminding.
5. Close the app from the recents list, lock the phone and repeat steps 2 to 4.
6. Sign out on the phone: the "Alerts for …" notification goes, and the phone no longer rings.

## When a phone does not ring

- No "Alerts for …" notification while someone is signed in: open the app once (Android does not
  let the listening start in the background), then check the battery settings above.
- The notification shows but nothing rings: check the ringer volume, Do Not Disturb and the
  "Alerts" category's sound in the app's notification settings.
- The app shows "Not connected": the phone is off the staff Wi-Fi or the server is down. Alerts
  missed meanwhile arrive when it reconnects (NTF-006).
- Rings only while the app is open: notifications are off (home says so), or the maker's battery
  saver stops the app; see Setting a phone up.
