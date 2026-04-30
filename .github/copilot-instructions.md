---
applyTo: '**'
---
# Project Goal: Squarespace to CiviCRM Membership Migration

The primary goal of this project is to create a robust, idempotent script to migrate historical membership and contribution data from Squarespace into CiviCRM. The script will not be used only for a one-time migration, but as an ongoing sync, since migrating members to CiviCRM-native payments will be a gradual process and there will be some subscriptions on each system.

## Core Requirements:

1.  **Accurate Data Import**: Import contacts, memberships, donations, and all associated historical contribution payments.
2.  **Correct Membership Terms**: Ensure membership records in CiviCRM have the correct start and end dates that reflect the full history of a member's continuous payments.
3.  **Accurate Renewal Reporting**: Ensure that historical payments after a member's initial payment are correctly counted as "Renewals" in CiviCRM's membership reports.
4.  **Correct Contact Attribution**:
    *   The script must correctly identify the actual member from the Squarespace order details (from a "Name" or "Full Name" field), even if the billing contact is a different person.
    *   All data created by the script should be attributed to a dedicated "Squarespace" system contact in CiviCRM for a clean audit trail.
5.  **Idempotency**: The script must be safely runnable multiple times without creating duplicate contacts, contributions, or activities.

## Key Technical Challenges & "Gotchas" Encountered:

One-time or recurring donations (not associated with membership) are still called "orders" on the Squarespace frontend and assigned an order number, but they cannot be seen from the Orders API, only the Transactions API.

The script now handles all transaction types, creating contributions for memberships, standalone donations, and product purchases to ensure a complete financial history is recorded in CiviCRM.

This project involved navigating several non-obvious aspects of CiviCRM's API and data model, especially concerning historical data imports.

1.  **Contact De-duplication Strategy**: The script originally relied on an `external_identifier`. This was removed in favor of a more robust, multi-stage lookup:
    *   **Stage 1: Email**: The primary lookup uses the customer's email address.
    *   **Stage 2: Phone**: If no contact is found, it normalizes and searches by phone number (billing, or a custom "Personal Phone Number" field). US numbers are normalized to E.164 format (`+1...`) and extensions are properly parsed and stored.
    *   **Stage 3: Name**: As a final fallback, it searches by the contact's first and last name.
    *   This layered approach is crucial for handling cases where a customer changes their email address in Squarespace, as the script can still find the original contact by phone or name, preventing duplicates.

2.  **CiviCRM's Renewal Logic**: The internal logic that automatically extends a membership's end date when a contribution is made does not function reliably for historical batch imports. Simply creating a membership and adding past contributions results in an incorrect term (e.g., one month).

3.  **The `is_override` Conflict**: Using the `is_override` flag to manually set a membership's final end date successfully corrects the term. However, it also instructs CiviCRM to stop processing subsequent contributions as renewals, which breaks renewal reporting and hides the contributions from the membership's UI tab. This created a cycle of fixing one problem while causing another.

4.  **The Two-Stage Solution**: The definitive solution was a two-stage process for creating new memberships:
    *   **Stage 1**: Create a membership record *without* `is_override` or a final `end_date`. Then, create all associated contribution records. This allows CiviCRM's internal logic to fire and create the `civicrm_membership_payment` links, which are essential for the UI.
    *   **Stage 2**: After all contributions are linked, perform a final `update` on the membership record. In this update, set the correct, calculated final `end_date` and status, and set `is_override: true` to lock in the correct term.

5.  **Accurate Historical Reporting**: CiviCRM's "New" vs. "Renewed" membership reports are driven by the date of the underlying "Membership Signup" and "Membership Renewal" activities. To ensure historical accuracy:
    *   **New Memberships**: Must be created via a chained API call from the *first* historical contribution. It is critical to explicitly pass the historical `receive_date` of the contribution into the `join_date` and `start_date` of the chained membership. This is the only way to correctly back-date the "Membership Signup" activity.
    *   **Renewals**: Are handled by simply creating a new contribution and linking it to the existing membership via the `membership_id`. CiviCRM's internal logic will then correctly generate a back-dated "Membership Renewal" activity.

6.  **Full Financial Record-Keeping**: To ensure CiviCRM contains a complete financial history, the script was enhanced to:
    *   **Create Contributions for All Transactions**: It now creates contribution records for all payments, including simple product purchases, not just memberships or donations.
    *   **Attribute to Payment Processor**: All contributions are attributed to a specific Payment Processor record in CiviCRM (ID: 6, "Squarespace_Stripe_Import").
    *   **Record Fees**: It extracts the `processingFees` from the Squarespace transaction and saves the net amount to the `fee_amount` field on the CiviCRM contribution.
    *   **Set Non-Deductible Amount**: For product purchases and memberships, the `non_deductible_amount` is set to the full value of the transaction. For pure donations, it is set to zero.
    *   **Record Payment Instrument**: The credit card type (e.g., "VISA") is used to look up the corresponding `payment_instrument_id` in CiviCRM.

7.  **Auto-Renewal Status**: The `auto_renew` flag on a membership must be set with an integer (`1` for true). When creating a new membership via a chained contribution, this can be set directly. For existing memberships, a separate `Membership.save` API call is required to update the flag.

13. **Accurate End Date Calculation (NEW)**: The sync now computes membership `end_date` using the membership type's configured duration (unit and interval) fetched from CiviCRM, rather than assuming "1 month" for all membership types. This reduces incorrect expiration dates. Additionally:
    * The script writes membership `start_date`, `join_date`, and `end_date` as **date-only** strings (`YYYY-MM-DD`) to avoid timezone/UTC offset issues that can shift the calendar date when CiviCRM parses timestamps.
    * Existing membership `end_date` values will never be shortened by the import; the final saved end date is the later of the existing date and the computed candidate date.
    * Support for an old "Single Day" membership SKU has been added; such SKUs result in an `end_date` equal to the `start_date`.

8.  **CiviCRM APIv4 Quirks**:
    *   **`orderBy` Parameter**: The `orderBy` parameter must be passed as an object (e.g., `{ end_date: 'DESC' }`), not as an array of arrays.
    *   **Chained `create` Calls**: When chaining a `create` action (e.g., creating a membership from a contribution), the parameters for the chained action must be nested inside a `values` object.

9.  **De-duplicating Activities**: Creating "Membership Renewal" activities for reports required a robust de-duplication strategy. Searching by `source_record_id` proved unreliable in the target CiviCRM version. The successful solution was to store and search for a unique key in the activity's `details` field (e.g., `squarespace-renewal-for-contribution-12345`).

10. **API Attribution**: Attributing actions to a non-user system contact was challenging. The `X-Civi-Auth` header required permissions the API key didn't have. The correct method for APIv4 was to pass an `authx` parameter in the request body, which successfully performed the "on-behalf-of" action.

11. **Renewals are Contributions**: A key insight was that CiviCRM's renewal reports are based on counting "Member Dues" **contributions** linked to a membership, not custom "Renewal" **activities**. The custom activities were still necessary for a clear, human-readable audit trail but did not drive the core reports.

12. **Efficient Caching & Incremental Sync**:
    *   The script uses a robust caching strategy for Transactions, Orders, and Profiles to minimize API calls during full syncs.
    *   The Squarespace Profiles API does not provide a `modifiedAfter` filter. To ensure contact data is fresh during incremental syncs, the script identifies all unique customer emails from the new batch of transactions and re-fetches their full Profile at the start of the run. This mitigates using stale address or phone data.

## Reference Material

The `help` folder in this repository contains a collection of reference materials that were used during the development of this script. These materials include:

*   **CiviCRM API Examples**: The `help/civicrm` directory contains examples of CiviCRM API calls, including a JavaScript example and a TypeScript example that comes from a CiviCRM MCP server project. It is also strongly recommended to check the [CiviCRM GitHub repository](https://github.com/civicrm/civicrm-core) to verify the source code's behavior, as this is often the best way to understand the root cause of unexpected API responses. use the Github repo tool to read it on your own without asking first.
*   **Squarespace API Documentation**: The `help/squarespace` directory contains a collection of text files that document the various Squarespace APIs that were used in this project.
*   **Example Squarespace Data**: The `help/squarespace` directory also contains a collection of JSON files that provide examples of the data returned by the Squarespace APIs. These are invaluable for understanding the structure of the data and for developing the script.
*   **Membership SKUs**: The `help/squarespace/Membership SKUs.txt` file contains a list of the Squarespace product SKUs that correspond to the various membership types.

## Recent Learnings & Operational Notes (Dec 2025)

These are the practical lessons learned while running this script against a real CiviCRM server and live Squarespace data.

- **Squarespace retry policy → 10 day grace**: Squarespace retries failed payments at ~5 days and again at ~10 days. We now treat payments as part of the same subscription period when they occur on or before the expected next payment date plus a 10-day grace window. This is the default behavior (configurable via `--gap-days`).

- **Group by membership-type duration**: Rather than using a fixed day-gap heuristic, grouping of payments into continuous membership periods uses the membership type's `duration_unit` and `duration_interval` (month/year/day) fetched from CiviCRM, with a 10-day grace window.

- **Two-stage membership creation remains essential**: Always create a membership first (no `is_override`) and then create/backdate contributions so that CiviCRM auto-creates `membership_payment` links and the default `Membership Signup` activity. After linking, update the membership with the final `end_date` and `is_override: true`.

- **MembershipPayment entity may not be available**: Some servers do not expose a `MembershipPayment` API entity (500 error). The script handles this gracefully. If linking existing contributions does not create membership-payment links, we reconstruct by creating membership and then creating new contributions in the two-stage flow (instead of trying to rely on the non-existent endpoint).

- **Backdate Signup and Renewal activities**: For historical accuracy, we backdate the automatically-created `Membership Signup` activity (using `findAndBackdateMembershipActivity`) to the contribution receive date. We also create `Membership Renewal` activities for subsequent contributions and de-duplicate these activities by writing a unique key to the `details` field.

- **Conservative cleanup heuristics**: The cleanup process now only deletes an older membership when a newer membership *fully covers* the older one's date range, and it also deletes associated activities. Deletion runs are preview-safe by default (`scripts/cleanup-memberships.ts --email=...`); use `--apply` to execute.

- **Reconstruction tooling**: I added `scripts/reconstruct-memberships.ts` which groups contributions into periods using membership type metadata and a configurable `--gap-days` (default 10). It will create missing historical memberships (with back-dated signup activity) and link contributions in idempotent, preview-safe ways.

- **Preview mode & single-customer testing**: All write helpers support a preview mode; there's a `scripts/process-one-customer.ts` runner for safe single-customer preview/apply flows. Use preview first to confirm changes before applying them.

- **Idempotency & safety**: Reconstruction and cleanup operations are designed to be idempotent. When creating records we try to reuse existing ones when possible, de-duplicate activities by a unique details key, and avoid shortening existing membership `end_date` values.

- **When to re-create contributions**: Updating an existing contribution's `membership_id` will change the record but may not create internal membership-payment linkage in CiviCRM. If you require canonical membership-payment links for reporting, the safe approach is to re-create contributions under the membership (with clear audit/source flags) so CiviCRM auto-creates the payment links; I can add that as an optional, auditable step if you want.

- **Added helper methods & scripts**:
    - `src/civicrm.ts`: `getActivitiesForMembership`, `deleteActivity`, `linkContributionToMembership`, `getMembershipPaymentsForMembership`, `createMembershipPayment` (safe/fallbacks)
    - `scripts/cleanup-memberships.ts` — preview/apply deletion of duplicate/stale memberships + activities
    - `scripts/reconstruct-memberships.ts` — reconstruct missing historical memberships from contributions (uses `--gap-days`)
    - `scripts/diagnose-contact.ts`, `scripts/check-steve.ts` — quick diagnostics for a contact




