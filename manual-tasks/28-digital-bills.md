# 28. Digital bills: the WhatsApp account and its template (BILL-012, OI-06, P7-09)

What it unblocks: sending a diner their bill on WhatsApp after they pay. The code is done
(P7-09a/b). Until the vendor's WhatsApp number and template are set up, the Control Plane answers
"not set up" and restaurants that turn digital bills on see their bills marked "Not sent".

The vendor's account sends for every restaurant. Its keys stay in the Control Plane's secret
manager and never reach a restaurant PC (SEC-002).

## 1. WhatsApp Business Platform (Business Owner)

1. In Meta Business Manager, verify the business: legal name, address and documents.
2. Create a WhatsApp Business Account and add a phone number that is not used on the WhatsApp app.
   Set its display name to the product's name (OI-01).
3. Create a **system user** with the `whatsapp_business_messaging` permission on that account, and
   generate a **permanent access token** for it.
4. Note the number's **Phone number ID**: WhatsApp Manager, then API Setup.

## 2. The message template

Submit it in WhatsApp Manager: Message templates, then Create. Use these settings:

- **Category**: Utility. It is a receipt for something the diner bought.
- **Name**: `digital_bill`.
- **Language**: English (`en`).
- **Body**, with five variables in this order:

  ```
  Thank you for dining at {{1}}. Your bill {{2}} for {{3}} is here: {{4}}
  The link works until {{5}}. Save or print the bill to keep it.
  ```

- **Sample values** (Meta asks for them): `Spice Route`, `INV/26-27/0412`, `₹1,250.00`,
  `https://cloud.example.in/v1/bills/...`, `03-11-2026`.

If Meta asks for changes, keep the five variables in the same order. If the approved name or
language differ, set `CP_WHATSAPP_TEMPLATE` and `CP_WHATSAPP_LANGUAGE` to match.

## 3. The Control Plane's settings (Super Admin)

Put these in each environment's secret manager:

| Setting                       | Value                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `CP_PUBLIC_URL`               | The Control Plane's public `https://` address. Diners open it.                   |
| `CP_DIGITAL_BILL_KEY`         | 32 random bytes in base64 (`openssl rand -base64 32`), new for each environment. |
| `CP_WHATSAPP_TOKEN`           | The system user's permanent token.                                               |
| `CP_WHATSAPP_PHONE_NUMBER_ID` | The Phone number ID.                                                             |
| `CP_DIGITAL_BILL_DAILY_LIMIT` | Optional. Default 3,000 a restaurant a day.                                      |

Changing `CP_DIGITAL_BILL_KEY` breaks every link already sent. Keep it unless it leaked.

## 4. Check it (staging)

1. On a test restaurant, open Settings, then Bills, and set "Digital bills" to WhatsApp.
2. Take an order and settle it. Before settling, enter your own mobile number and tick the
   diner's consent.
3. Check each of these:
   - the message arrives within a minute;
   - the link opens the bill as printed;
   - the POS shows "Sent to +91 ******1234".
4. In the database, `digital_bills` holds only the masked number.

Record the date and the result in PROGRESS.md under P7-09.

## 5. SMS (only if the Business Owner wants it, OI-06)

SMS bills need TRAI DLT registration before any provider may send them:

- the entity;
- a sender ID (header);
- a content template with the same five values.

The code has a place for an SMS adapter behind the same interface. Ask Claude to add the chosen
provider (MSG91, Gupshup, Kaleyra or another) once the DLT registration is approved.
