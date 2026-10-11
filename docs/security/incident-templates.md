# Incident templates

Templates for [the incident response plan](incident-response.md) (SEC-016). Fill the _italic_ parts;
counsel reads any notice that mentions personal data before it goes. Say what is known, no more.

## To a restaurant's Owner (first message, same day)

> Subject: Security notice for _restaurant name_, _date_
>
> We are writing to tell you about a security incident that may affect _restaurant name_. We found it
> on _date and time IST_.
>
> **What happened:** _one or two plain sentences_.
> **What it affects:** _the PC, the QR ordering, the cloud backup, nothing at the restaurant_.
> **Your data:** _what we know and do not yet know_ (names and phone numbers of diners, staff, nothing).
> **What we have done:** _contained, rotated, restored_.
> **What you should do now:** _steps for the restaurant, see below_.
> **Your trading:** the POS, kitchen display and waiter phones continue to work on the restaurant
> network. _Exceptions._
>
> We will update you every _hours_ hours. _Name and phone of the person to call_.
>
> Under the Digital Personal Data Protection Act you may have duties to tell the Data Protection Board
> of India and the people affected. We will help you with the wording and the list of people; this is
> a note of facts, not legal advice.

## To a restaurant's Owner (the update, and the close)

> Update _n_ on the incident of _date_. **Status:** _investigating / contained / recovered_.
> **New facts:** _..._ **Next update:** _time_. When closed: **Cause:** _..._ **What we changed:** _..._
> **What remains for you:** _..._

## Notice to the Data Protection Board (for the restaurant, as fiduciary)

The restaurant sends it; the vendor drafts it. Counsel checks the current form and channel.

> 1. Who: _restaurant, address, Owner, contact_; processor: _vendor name, contact_.
> 2. Nature, extent, timing and place of the breach: _..._
> 3. Likely impact on the people affected: _..._
> 4. Number of people and the kinds of data: _..._
> 5. What was done to limit it, and to prevent it recurring: _..._
> 6. Findings on who caused it and why (if known): _..._ (in the 72-hour report)
> 7. Steps taken to notify the people: _..._

## To diners

> Subject: A security notice from _restaurant name_
>
> On _date_ we found that _short plain description_. It involved your _name / phone number_ that you
> gave when ordering with the QR code at _restaurant_ on _dates_. It did **not** involve _card numbers:
> we never take payments through the QR menu_.
>
> **What you can do:** be careful of messages that mention your visit and ask for money or codes;
> do not click links in them. _Anything specific._
> **What we have done:** _..._
> You can write to _contact name, email, phone_ with questions.

## To staff

> A security incident affected _what_. Your _PIN is stored only as a hash / phone number was exposed_.
> We have _reset PINs, deactivated devices_. Please _choose a new PIN at next sign-in; tell the
> manager at once if you see a phone or tablet missing_. Questions to _contact_.

## Guidance for restaurants: QR tents and stickers

(RELAY-S4. Print it for the restaurant's file; the installer's visit sheet points to it.)

1. **Know the real address.** Every tent prints the site's address as text under the QR code. The
   Owner and staff learn it by heart; only that address is real. The real site **never** asks diners
   to pay, to give card details or a bank login.
2. **Look at the tents at every opening and every table turnover on busy days.** A sticker over the
   code, a tent that is not yours, a different print quality, a code that scans to another address
   all mean: peel it off, keep it, tell the manager.
3. **Use tents that show tampering** (tamper-evident or void-if-removed labels for the printed code,
   or tents in a holder that cannot be covered), and keep the spare tents locked away.
4. **When you find one:** remove it; give the table a new code (**Manage → QR codes → New code**);
   put out a fresh tent; write down the table, time and who found it; call support
   (_support phone_). Do not scan it with your own phone while on the staff Wi-Fi.
5. **Tell diners** who ordered from that table while the sticker was there (the template above), and
   say what the real site never does. Put a line on the table: "Our QR menu never asks for payment."
6. **Report** to the police (cyber crime portal, cybercrime.gov.in) if anyone paid.

## Guidance for restaurants: ransomware and a dead PC

1. Unplug the PC from the network. Do not pay and do not reply to the attacker. Call support.
2. Trade on paper tickets. Waiters' phones keep unsent orders and send them when the server is back.
3. Keep the backup drives **unplugged** until support says. Find the **recovery key** (the printed
   sheet from installation): without it a backup cannot be restored.
4. Support brings a new PC and restores. Afterwards, every phone and tablet is paired again.
5. Afterwards: no email or browsing on the POS PC; only the Owner holds the administrator password;
   the backup drive is unplugged outside backup hours.
