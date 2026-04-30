# Project Requirements: Squarespace to CiviCRM Sync

## CiviCRM Membership Accounting
- **Sync Methodology**: All membership-related contributions must be synced using the CiviCRM APIv4 **Order** entity (or correctly linked **LineItems**). This ensures that the contribution record is natively linked to the membership period in the `civicrm_line_item` table.
- **Financial Statistics**: The goal is to ensure CiviCRM dashboard statistics (revenue, member counts) are perfectly accurate by avoiding manual database overrides where possible.
- **Membership Status**: Prefer letting CiviCRM calculate membership statuses automatically based on payment and duration dates (`is_override: false`) instead of forcing manual statuses.
- **De-duplication**: Always check for existing `trxn_id` or `invoice_id` before creating new `Order` or `Contribution` records to prevent duplicate financial data.
- **Historical Backfilling**: When backfilling historical data, ensure the `receive_date` on the contribution matches the original Squarespace transaction date to maintain accurate accounting history.

## Recovery Log & Lessons Learned

### Membership Reporting Fix
- **Discovery**: CiviMember "Renewal" statistics are NOT derived from membership end-dates or contribution records alone. They require a formal `Activity` record of Type `Membership Renewal` (ID 2) linked to the membership.
- **Recovery**: Refactored `recordMembershipActivity` in `src/civicrm.ts` to explicitly create these activities during the sync. This ensures the dashboard natively counts each year's payments correctly.

### APIv4 Hardening
- **Mistake**: Initially omitted `source_contact_id` from the `Activity::create` call, which is a mandatory field for activity creation in most CiviCRM configurations (APIv4). This caused 500 Internal Server Errors during the re-sync.
- **Recovery**: Hardcoded `source_contact_id: 2511` (Sync User) into the activity creation payload.

### Process Safety & Concurrency
- **Problem**: Encountered a "Race Condition" where multiple background sync workers were accidentally launched in parallel. This led to over 4,900 duplicate activity logs and ambiguous financial linking.
- **Solution**: Implemented a **Lock File** mechanism (`.sync.lock`) in `src/index.ts`. The script now checks for this file on startup, records its PID, and aborts if another sync is already in progress. It also includes automatic cleanup listeners for SIGINT/SIGTERM.

### Squarespace Billing & Door Access Lifecycle
- **Day 0 (End Date)**: Last paid period expires.
- **Day 1 - Day 5 (Grace)**: Squarespace will attempt a retry on Day 5. Physical door access remains available during this window to avoid unnecessary friction.
- **Day 5 - Day 10 (Lockout)**: If the first retry fails, physical door access is cut off to "bring attention to the issue," as only one automatic attempt remains. In CiviCRM, this should not be reflected as an inactive state, they're still in the grace period.
- **Day 10 (Final Attempt)**: The third and final automatic charge happens. 
    - **Success**: Access is resumed immediately. The membership is considered continuous across the 10-day gap, as the billing cycle does not change.
    - **Failure**: Membership is officially **terminated** in CiviCRM, as Squarespace will not attempt further charges.

