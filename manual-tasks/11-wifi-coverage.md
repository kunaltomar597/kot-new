# 11 Wi-Fi coverage walk test (P0-H2)

Why: pagers, waiter phones and table tablets all depend on the restaurant's 2.4 GHz Wi-Fi
(risk R-02, assumption A-03). A dead spot in the kitchen, at the pass or on the terrace means
missed alerts. This test finds dead spots before the pilot, so an access point can be added.

Ready to run: **the first pass yes** (with a phone). A second pass with a pager in its signal-log
mode follows once the pager firmware exists (P0-H1, P2-05).

## What you need

- An Android phone with a free Wi-Fi analyzer app that shows signal strength in dBm (for example
  "WiFi Analyzer (open source)" from F-Droid or Play Store).
- The restaurant's floor plan (a photo of a hand sketch is fine).
- 30 minutes during a normal service if possible (people and steam change the signal).

## Steps

1. In the app, select the restaurant's network name. Note which band it is on: the pagers use
   **2.4 GHz** (channel 1 to 13). If the router shows one name for both bands, pick the 2.4 GHz
   entry.
2. Mark these spots on the floor plan and number them: the cashier counter, each kitchen station,
   the pass (where dishes wait), every 3 to 4 tables on the floor, the terrace corners, the
   washroom corridor, the store room, and the entrance.
3. Stand at each spot for 20 seconds holding the phone at waist height (where a pager is worn)
   and note the signal in dBm. Write the lowest value you see.
4. Do it twice: once with the kitchen idle, once during a busy hour.
5. Note any spot where the phone drops the Wi-Fi or a web page will not open.

How to read the numbers: **-60 dBm or better** is good; **-60 to -70** is usable; **worse than -70**
(for example -75) is a problem for pagers and needs an access point nearer.

## Results template

```
Router / access points: <make, model, where they are>
Network band used: 2.4 GHz channel <n>
Idle or busy: <idle/busy>, date and time

Spot | Where                 | Signal (dBm) | Dropped? | Note
1    | Cashier counter       |              |          |
2    | Kitchen – tandoor     |              |          |
3    | Pass                  |              |          |
...

Floor plan photo with the numbers: (attach)
```

Paste it into a Claude session. Claude records it in PROGRESS.md and says where an access point is
needed.
