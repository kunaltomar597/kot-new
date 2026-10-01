# 13 Thermal printer compatibility (P0-H4)

Why: kitchen tickets (KOT) and GST bills must print on the printers the restaurant will buy, over
the network (Ethernet/Wi-Fi) and over USB, on 80 mm and 58 mm paper (KDS-008, BILL-014). Some
cheap printers mangle the ₹ sign, long dish names or Indian digit grouping; this test finds that
before the pilot.

Ready to run: **yes for network printers** (on this Mac). USB printers need the Windows PC with
the installer (task 14) and are tested there.

## What you need

- Each printer model you are considering, with paper, power and a network cable to the same
  router as this Mac (or joined to the same Wi-Fi).
- 30 minutes per printer.

## Steps

1. **Find the printer's IP address.** Most thermal printers print a self-test page when you hold
   the feed button while switching them on. Note the IP address (for example `192.168.1.50`).
   If it shows `0.0.0.0` or nothing, set an address with the maker's tool or ask Claude.
2. **Start the system.** In a Claude session say: "Start the system for the printer test." Claude
   starts the restaurant server with the demo restaurant and opens the console in your browser,
   and tells you when it is ready.
3. **Sign in** as Vikram (Manager), PIN `2222`.
4. **Add the printer:** Dashboard → Kitchen and printers → Add a printer. Name it after the model,
   choose Network, type the IP address, port `9100`, and the paper width (80 or 58 mm). Save.
5. **Test page:** press "Print a test page" on its row. It prints "TEST PAGE", the restaurant
   name, the printer's name, the paper width, the time and a ruler of digits across the full
   width (check the last digit is not cut off). If it does not print, the message on screen says
   why; note it.
6. **Kitchen tickets:** on the Kitchen row choose Change → "Kitchen screen and printed tickets"
   and pick this printer. Then go to the POS, open a table, add three dishes (one with a long
   name, one with add-ons and an instruction such as "less spicy") and send them. A KOT prints.
7. **Bill:** on the same table choose Bill → print. Check the ₹ sign, the GSTIN, the tax lines,
   the round-off and the total. Print it again: the second copy must say **DUPLICATE**.
8. **Printer offline:** unplug the printer's network cable, add one more dish and send it. Within
   a minute the POS and the dashboard show the printer as offline. Plug the cable back in: the
   waiting ticket prints by itself.
9. Repeat steps 4 to 8 for each printer and paper width.

## Results template

Copy this, fill it in and paste it into a Claude session.

```
Printer: <make and model>, <80/58> mm, firmware <if printed on the self-test page>
Connection: network <IP> / USB
Test page printed:            yes / no (message: ...)
₹ sign correct:               yes / no (what it shows instead: ...)
Long dish name wraps cleanly: yes / no
Add-ons and instruction shown: yes / no
Bill layout fits the paper:   yes / no (what is cut off: ...)
DUPLICATE on reprint:         yes / no
Offline alert appeared:       yes / no, after about ... seconds
Waiting ticket printed when back online: yes / no
Paper cut at the end:         yes / no / printer has no cutter
Anything else odd:
Photo of a KOT and a bill:    (attach if you can)
```
