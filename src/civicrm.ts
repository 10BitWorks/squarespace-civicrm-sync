import axios from 'axios';
import * as dotenv from 'dotenv';
import { URLSearchParams } from 'url';
import { CiviCRMContact, CiviCRMContribution, CiviCRMMembership, SquarespaceProfile } from './types';

dotenv.config();

const CIVICRM_API_URL = process.env.CIVICRM_API_URL;
const CIVICRM_API_KEY = process.env.CIVICRM_API_KEY;
const CIVICRM_SITE_KEY = process.env.CIVICRM_SITE_KEY;

export class CiviCRM {
  private preview: boolean = false;

  constructor(options?: { preview?: boolean }) {
    if (options && options.preview) this.preview = true;
  }
  public async apiRequest(entity: string, action: string, params: object) {
    if (!CIVICRM_API_URL) {
      throw new Error('CIVICRM_API_URL is not defined in .env');
    }

    let url: string;
    let body: string;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${CIVICRM_API_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
    };

    if (CIVICRM_SITE_KEY) {
      headers['X-Civi-Key'] = CIVICRM_SITE_KEY;
    }

    // Based on CiviCRM source code (CRM/Api4/Page/AJAX.php and js/crm.ajax.js),
    // the server expects form-urlencoded data with a JSON-stringified payload.
    const requestData = {
      params: JSON.stringify(params),
    };

    if (action === 'get' || action === 'create' || action === 'update' || action === 'save' || action === 'delete') {
      // Simple actions use the specific endpoint and a 'params' field.
      url = `${CIVICRM_API_URL}${entity}/${action}`;
      body = new URLSearchParams(requestData).toString();
    } else {
      // True batch actions would use the generic endpoint and a 'calls' field.
      // For this script, we are only performing single actions.
      throw new Error(`Action "${action}" is not configured for this script's API logic.`);
    }

    try {
      const response = await axios.post(url, body, { headers });
      return response.data;
    } catch (error: any) {
      console.error(`Error calling CiviCRM API (${entity}/${action}):`);
      if (error.response) {
        console.error(`Status: ${error.response.status}`);
        console.error('Request Params:', JSON.stringify(params, null, 2));
        const contentType = error.response.headers['content-type'];
        if (contentType && contentType.includes('application/json')) {
          console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else if (contentType && contentType.includes('text/html')) {
          const match = /<div class="crm-section crm-error-message">([^<]+)<\/div>/.exec(error.response.data);
          if (match && match[1]) {
            console.error('Server Error:', match[1].trim());
          } else {
            console.error('Server returned an HTML error page instead of JSON. This often indicates a fatal server-side error. Please check your CiviCRM and web server logs for the full error message.');
          }
        } else {
          console.error('Data:', error.response.data);
        }
      } else if (error.request) {
        console.error('No response received from server:', error.request);
      } else {
        console.error('Error setting up request:', error.message);
      }
      throw error;
    }
  }

  public async getContactByEmail(email: string): Promise<CiviCRMContact | null> {
    const emailResult = await this.apiRequest('Email', 'get', {
      select: ['contact_id'],
      where: [['email', '=', email]],
      limit: 1,
    });

    if (emailResult && emailResult.count > 0) {
      const contactId = emailResult.values[0].contact_id;
      const result = await this.apiRequest('Contact', 'get', {
        select: ['id', 'first_name', 'last_name', 'external_identifier', 'created_date'],
        where: [['id', '=', contactId]],
        limit: 1,
      });
      if (result && result.count > 0) {
        return result.values[0];
      }
    }

    return null;
  }

  // Parse a US phone string, extracting extension if present. Returns the
  // digits-only national number (last 10 digits) and the extension (if any).
  private parsePhoneAndExtension(phone: string): { national?: string; extension?: string } {
    if (!phone) return {};
    // Remove common separators and detect extension patterns like 'x123', 'ext 123', '#123'
    const extMatch = /(?:ext(?:ension)?|x|#)\s*[:\-\.\s]*?(\d{1,6})$/i.exec(phone.trim());
    let extension: string | undefined;
    let cleaned = phone;
    if (extMatch) {
      extension = extMatch[1];
      cleaned = phone.slice(0, extMatch.index);
    }
    // Remove non-digit characters
    const digits = cleaned.replace(/\D/g, '');
    if (!digits) return { extension };
    const national = digits.slice(-10);
    if (national.length !== 10) return { extension };
    return { national, extension };
  }

  public async getContactByPhone(phone: string): Promise<CiviCRMContact | null> {
    if (!phone) return null;
    const parsed = this.parsePhoneAndExtension(phone);
    if (!parsed.national) return null;
    const last10 = parsed.national;
    const normalized = `+1${last10}`;

    let phoneResult = await this.apiRequest('Phone', 'get', {
      select: ['contact_id'],
      where: [['phone', '=', normalized]],
      limit: 1,
    });
    
    if (!phoneResult || phoneResult.count === 0) {
      phoneResult = await this.apiRequest('Phone', 'get', {
        select: ['contact_id'],
        where: [['phone', '=', last10]],
        limit: 1,
      });
    }

    if (!phoneResult || phoneResult.count === 0) {
      phoneResult = await this.apiRequest('Phone', 'get', {
        select: ['contact_id'],
        where: [['phone', 'LIKE', `%${last10}`]],
        orderBy: { 'id': 'DESC' },
        limit: 1,
      });
    }

    if (phoneResult && phoneResult.count > 0) {
      const contactId = phoneResult.values[0].contact_id;
      const contactResult = await this.apiRequest('Contact', 'get', {
        select: ['id', 'first_name', 'last_name', 'external_identifier', 'created_date'],
        where: [['id', '=', contactId]],
        limit: 1,
      });
      if (contactResult && contactResult.count > 0) return contactResult.values[0];
    }

    return null;
  }

  // Normalize US phone numbers to E.164 (+1NNNNNNNNNN) where possible and
  // also extract extensions. Returns { normalized, extension } where values may be null.
  public normalizePhone(phone: string | null | undefined): { normalized?: string | null; extension?: string | null } {
    if (!phone) return { normalized: null, extension: null };
    const parsed = this.parsePhoneAndExtension(phone);
    if (!parsed.national) return { normalized: null, extension: parsed.extension || null };
    return { normalized: `+1${parsed.national}`, extension: parsed.extension || null };
  }

  public async getContactByName(firstName: string, lastName: string): Promise<CiviCRMContact | null> {
    if (!firstName || !lastName) {
      return null;
    }
    const result = await this.apiRequest('Contact', 'get', {
      select: ['id', 'first_name', 'last_name', 'external_identifier', 'created_date'],
      where: [
        ['first_name', '=', firstName],
        ['last_name', '=', lastName],
      ],
      limit: 1,
    });

    if (result && result.count > 0) {
      return result.values[0];
    }

    return null;
  }

  public async saveOrder(order: any) {
    if (this.preview) {
      console.log('Preview: Order.create', { order });
      return { values: [{ id: -1 }], created: true };
    }
    return this.apiRequest('Order', 'create', order);
  }

  /**
   * High-level method to sync a membership and its payment using the Order API.
   * This ensures proper financial linkage for accurate dashboard stats.
   */
  public async syncMembershipWithPayment(params: {
    contactId: number;
    membershipTypeId: number;
    priceFieldValueId: number;
    amount: number;
    currency: string;
    trxnId: string;
    receiveDate: string;
    source: string;
    membershipId?: number; // If provided, it will RENEW/UPDATE this membership
  }) {
    // 1. Check for existing contribution to avoid duplicates
    const existing = await this.apiRequest('Contribution', 'get', {
      where: [['trxn_id', '=', params.trxnId]],
      select: ['id', 'membership_id']
    });

    if (existing && existing.count > 0) {
      console.log(`Skipping Order.create: Contribution with trxn_id ${params.trxnId} already exists (ID: ${existing.values[0].id}).`);
      return { values: [existing.values[0]], created: false };
    }

    // 2. Prepare Order params
    const orderParams = {
      contributionValues: {
        contact_id: params.contactId,
        financial_type_id: 2, // Member Dues
        receive_date: params.receiveDate,
        payment_instrument_id: 1, // Credit Card
        total_amount: params.amount,
        trxn_id: params.trxnId,
        source: params.source,
      },
      lineItems: [
        {
          line_total: params.amount,
          qty: 1,
          unit_price: params.amount,
          label: params.source,
          financial_type_id: 2,
          price_field_value_id: params.priceFieldValueId,
          entity_table: 'civicrm_membership',
          entity_id: params.membershipId, // Will update if exists
          params: {
            membership_type_id: params.membershipTypeId,
          }
        }
      ]
    };

    return this.saveOrder(orderParams);
  }

  public async saveContact(profile: SquarespaceProfile, existingContact?: CiviCRMContact) {
    const contactRecord: any = {
      first_name: profile.firstName,
      last_name: profile.lastName,
      contact_type: 'Individual',
    };

    // If an existing contact is found, we're updating.
    if (existingContact?.id) {
      contactRecord.id = existingContact.id;

      // Only update created_date if the new one is older.
      if (existingContact.created_date && new Date(profile.createdOn) < new Date(existingContact.created_date)) {
        contactRecord.created_date = profile.createdOn;
      }
    } else {
      // This is a new contact. Do not set or rely on an external identifier here;
      // matching will be performed by email or phone lookups prior to creating.
      if (profile.createdOn) contactRecord.created_date = profile.createdOn;
      contactRecord.source = 'Squarespace';
    }

    const chain: any = {};

    // Set all existing emails, phones, addresses to non-primary before adding the new one.
    if (existingContact?.id) {
      chain.unset_primary_email = ['Email', 'update', {
        where: [['contact_id', '=', existingContact.id]],
        values: { is_primary: false },
      }];
      chain.unset_primary_phone = ['Phone', 'update', {
        where: [['contact_id', '=', existingContact.id]],
        values: { is_primary: false },
      }];
      chain.unset_primary_address = ['Address', 'update', {
        where: [['contact_id', '=', existingContact.id]],
        values: { is_primary: false },
      }];
    }

    if (profile.email) {
      chain.email = ['Email', 'save', {
        records: [{
          email: profile.email,
          contact_id: '$id',
          is_primary: true,
        }],
        defaults: { location_type_id: 1 },
        match: ['email', 'contact_id'],
      }];
    }

    if (profile.address) {
      const provinceId = await this.getProvinceId(profile.address.state);
      if (provinceId) {
        chain.address = ['Address', 'save', {
          records: [{
            contact_id: '$id',
            location_type_id: 1,
            is_billing: true,
            is_primary: true,
            street_address: profile.address.address1,
            city: profile.address.city,
            postal_code: profile.address.postalCode,
            state_province_id: provinceId,
          }],
          // Matching on all address fields to avoid creating duplicates of the same address.
          match: ['contact_id', 'street_address', 'city', 'state_province_id', 'postal_code'],
        }];
      }
    }

    if (profile.phone) {
      const norm = this.normalizePhone(profile.phone);
      const phoneValue = (norm && norm.normalized) || profile.phone;
      const ext = norm && norm.extension ? norm.extension : null;
      const locationType = ext ? (await this.getLocationTypeId('Work') || 1) : (await this.getDefaultLocationTypeId() || 1);

      chain.phone = ['Phone', 'save', {
        records: [{
          contact_id: '$id',
          location_type_id: locationType,
          phone: phoneValue,
          phone_type_id: 2, // Mobile
          phone_ext: ext,
          is_primary: true,
        }],
        match: ['contact_id', 'phone'],
      }];
    }

    const params: any = {
      records: [contactRecord],
      chain: chain,
    };

    // We intentionally avoid matching on external_identifier here. The caller
    // should locate existing contacts by email or phone before calling saveContact.
    if (this.preview) {
      // In preview mode, mimic a successful save and return a placeholder ID
      const fakeId = existingContact?.id || -1;
      console.log('Preview: Contact.save', { contactRecord });
      return { values: [{ id: fakeId }] };
    }

    return this.apiRequest('Contact', 'save', params);
  }

  public async saveContribution(contribution: CiviCRMContribution, chain?: any) {
    // If we are chaining, we assume we are creating a new contribution and skip the checks.
    if (chain) {
      if (this.preview) {
        console.log('Preview: Contribution.create (chained)', { contribution });
        return { values: [{ id: -1 }], created: true };
      }
      const params: any = { values: contribution, chain: chain };
      return this.apiRequest('Contribution', 'create', params);
    }

    // Check for existing contribution by trxn_id
    const existingByTrxn = await this.apiRequest('Contribution', 'get', {
      select: ['id'],
      where: [['trxn_id', '=', contribution.trxn_id]],
      limit: 1,
    });

    let existingId = (existingByTrxn && existingByTrxn.count > 0) ? existingByTrxn.values[0].id : null;

    // If not found, check by invoice_id
    if (!existingId && contribution.invoice_id) {
      const existingByInvoice = await this.apiRequest('Contribution', 'get', {
        select: ['id'],
        where: [['invoice_id', '=', contribution.invoice_id]],
        limit: 1,
      });
      if (existingByInvoice && existingByInvoice.count > 0) {
        existingId = existingByInvoice.values[0].id;
      }
    }

    if (existingId) {
      // The contribution already exists. The membership linking is handled by CiviCRM's
      // internal logic during the two-stage import, so we don't need to update anything here.
      // We just return the ID for consistency.
      // console.log(`Contribution with trxn_id "${contribution.trxn_id}" or invoice_id "${contribution.invoice_id}" already exists (ID: ${existingId}). Skipping creation.`);
      return { values: [{ id: existingId }], created: false };
    } else {
      // Create new contribution
      // Ensure we pass through new optional properties: payment_processor_id, payment_instrument_id, fee_amount, non_deductible_amount
      const values: any = { ...contribution };
      // API expects numeric fields to be present and set to null or a number
      if (values.payment_processor_id === undefined) delete values.payment_processor_id;
      if (values.payment_instrument_id === undefined) delete values.payment_instrument_id;
      if (values.fee_amount === undefined) delete values.fee_amount;
      if (values.non_deductible_amount === undefined) delete values.non_deductible_amount;

      if (this.preview) {
        console.log('Preview: Contribution.create', { values });
        return { values: [{ id: -1 }], created: true };
      }
      const result = await this.apiRequest('Contribution', 'create', {
        values,
      });
      return { ...result, created: true };
    }
  }

  private financialTypeIdCache: { [name: string]: number } = {};

  public async getFinancialTypeId(name: string): Promise<number> {
    if (this.financialTypeIdCache[name]) {
      return this.financialTypeIdCache[name];
    }
    const result = await this.apiRequest('FinancialType', 'get', {
      select: ['id'],
      where: [['name', '=', name]],
    });
    if (result && result.count > 0) {
      const id = result.values[0].id;
      this.financialTypeIdCache[name] = id;
      return id;
    }
    throw new Error(`Could not find the "${name}" Financial Type in CiviCRM.`);
  }

  private membershipTypeIdCache: { [name: string]: number } = {};
  private membershipStatusIdCache: { [name: string]: number } = {};

  public async getMembershipTypeId(name: string): Promise<number> {
    if (this.membershipTypeIdCache[name]) {
      return this.membershipTypeIdCache[name];
    }
    const result = await this.apiRequest('MembershipType', 'get', {
      select: ['id'],
      where: [['name', '=', name]],
    });
    if (result && result.count > 0) {
      const id = result.values[0].id;
      this.membershipTypeIdCache[name] = id;
      return id;
    }
    throw new Error(`Could not find the "${name}" Membership Type in CiviCRM.`);
  }

  public async getMembershipStatusId(name: string): Promise<number> {
    if (this.membershipStatusIdCache[name]) {
      return this.membershipStatusIdCache[name];
    }
    const result = await this.apiRequest('MembershipStatus', 'get', {
      select: ['id'],
      where: [['name', '=', name]],
    });
    if (result && result.count > 0) {
      const id = result.values[0].id;
      this.membershipStatusIdCache[name] = id;
      return id;
    }
    throw new Error(`Could not find the "${name}" Membership Status in CiviCRM.`);
  }

  public async saveActivity(activity: any, contributionIdForDedup?: number) {
    // If a contribution ID is provided for de-duplication, we'll create a unique key
    // and store it in the 'details' field. This is a robust way to prevent duplicates.
    if (contributionIdForDedup) {
      const uniqueKey = `squarespace-renewal-for-contribution-${contributionIdForDedup}`;

      const existingActivity = await this.apiRequest('Activity', 'get', {
        select: ['id'],
        where: [['details', '=', uniqueKey]],
        limit: 1,
      });

      if (existingActivity && existingActivity.count > 0) {
        // console.log(`Renewal activity for contribution ${contributionIdForDedup} already exists. Skipping.`);
        return { ...existingActivity, created: false };
      }

      // Add the unique key to the payload before creating.
      activity.details = uniqueKey;
      // Also save the proper source_record_id for data integrity, even though we don't query on it.
      activity.source_record_id = contributionIdForDedup;
    }

    if (this.preview) {
      console.log('Preview: Activity.create', { activity });
      return { values: [{ id: -1 }], created: true };
    }

    const result = await this.apiRequest('Activity', 'create', {
      values: activity,
    });
    return { ...result, created: true };
  }

  private activityTypeIdCache: { [name: string]: number } = {};

  public async getActivityTypeId(name: string): Promise<number> {
    if (this.activityTypeIdCache[name]) {
      return this.activityTypeIdCache[name];
    }
    // Note: We are getting the 'value' (which is the ID) from the OptionValue table
    // where the machine 'name' of the option matches.
    const result = await this.apiRequest('OptionValue', 'get', {
      select: ['value'],
      where: [['option_group_id.name', '=', 'activity_type'], ['name', '=', name]],
      limit: 1
    });
    if (result && result.count > 0) {
      const id = result.values[0].value;
      this.activityTypeIdCache[name] = id;
      return id;
    }
    throw new Error(`Could not find an Activity Type with the name "${name}" in CiviCRM.`);
  }

  private paymentInstrumentIdCache: { [name: string]: number } = {};

  public async getPaymentInstrumentId(name: string): Promise<number | null> {
    if (!name) return null;
    if (this.paymentInstrumentIdCache[name]) {
      return this.paymentInstrumentIdCache[name];
    }
    // Try to find the option value by the provided name (case-insensitive match)
    const possibleNames = [name, name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(), 'Credit Card'];
    for (const candidate of possibleNames) {
      try {
        const result = await this.apiRequest('OptionValue', 'get', {
          select: ['value'],
          where: [['option_group_id.name', '=', 'payment_instrument'], ['name', '=', candidate]],
          limit: 1,
        });
        if (result && result.count > 0) {
          const id = result.values[0].value;
          this.paymentInstrumentIdCache[name] = id;
          return id;
        }
      } catch (err) {
        // Continue and try next candidate
      }
    }
    return null;
  }

  public async findAndBackdateMembershipActivity(contactId: number, membershipId: number, newDate: string, sourceContactId: number) {
    try {
      // The default activity type for this is 'Membership Signup'.
      const membershipSignupActivityTypeId = await this.getActivityTypeId('Membership Signup');

      // Find the most recent 'Membership Signup' activity for the target contact.
      // This is presumed to be the one CiviCRM just created automatically.
      const activityContacts = await this.apiRequest('ActivityContact', 'get', {
        select: ['activity_id'],
        where: [
          ['contact_id', '=', contactId],
          ['record_type_id', '=', 3], // 3 = Activity Targets
        ],
        orderBy: { 'id': 'DESC' },
        limit: 20,
      });
      
      let existingActivity = null;
      if (activityContacts && activityContacts.count > 0) {
        const activityIds = activityContacts.values.map((v: any) => v.activity_id);
        existingActivity = await this.apiRequest('Activity', 'get', {
          select: ['id', 'activity_date_time'],
          where: [
            ['id', 'IN', activityIds],
            ['activity_type_id', '=', membershipSignupActivityTypeId],
          ],
          orderBy: { activity_date_time: 'DESC' },
          limit: 1,
        });
      }

      if (existingActivity && existingActivity.count > 0) {
        const activityId = existingActivity.values[0].id;
        const activityDate = new Date(existingActivity.values[0].activity_date_time);
        const now = new Date();
        const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

        // As a safeguard, only update the activity if it was created in the last 5 minutes.
        if (now.getTime() - activityDate.getTime() > fiveMinutes) {
          console.warn(`The latest 'Membership Signup' activity for contact ${contactId} (ID: ${activityId}) is older than 5 minutes. It might not be the correct one to update for membership ${membershipId}. Skipping back-dating.`);
          return;
        }

        console.log(`Found default membership activity (ID: ${activityId}) for contact ${contactId}. Back-dating it.`);
        return this.apiRequest('Activity', 'update', {
          where: [['id', '=', activityId]],
          values: {
            activity_date_time: newDate,
            source_contact_id: sourceContactId,
          },
        });
      } else {
        console.warn(`Could not find a default "Membership Signup" activity for contact ID ${contactId} to link with membership ID ${membershipId}.`);
      }
    } catch (error) {
      console.error('Error while trying to backdate membership activity:', error);
    }
  }

  public async getMembershipsForContact(contact_id: number) {
    const result = await this.apiRequest('Membership', 'get', {
      select: ['id', 'membership_type_id', 'start_date', 'end_date', 'status_id', 'join_date', 'is_override'],
      where: [['contact_id', '=', contact_id]],
      orderBy: { end_date: 'DESC' },
    });
    return result && result.count > 0 ? result.values : [];
  }

  /**
   * Return overlapping membership pairs (if any) for a contact.
   * Useful for diagnostics after an import run.
   */
  public async detectOverlappingMemberships(contact_id: number) {
    const memberships = await this.getMembershipsForContact(contact_id);
    if (!memberships || memberships.length <= 1) return [];

    const toDateOnly = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`);
    // Sort by start_date ascending for checking overlaps
    const withDates = memberships
      .filter((m: any) => m.start_date && m.end_date)
      .map((m: any) => ({ ...m, _start: toDateOnly(m.start_date), _end: toDateOnly(m.end_date) }))
      .sort((a: any, b: any) => a._start.getTime() - b._start.getTime());

    const overlaps: Array<{ a: any; b: any }> = [];
    for (let i = 0; i < withDates.length - 1; i++) {
      const a = withDates[i];
      for (let j = i + 1; j < withDates.length; j++) {
        const b = withDates[j];
        if (a._end.getTime() >= b._start.getTime()) {
          overlaps.push({ a, b });
        }
      }
    }
    return overlaps;
  }

  public async getContributionsForContact(contact_id: number) {
    const result = await this.apiRequest('Contribution', 'get', {
      select: ['id', 'total_amount', 'receive_date', 'trxn_id', 'invoice_id', 'financial_type_id'],
      where: [['contact_id', '=', contact_id]],
      orderBy: { receive_date: 'DESC' },
    });
    return result && result.count > 0 ? result.values : [];
  }

  public async saveMembership(membership: CiviCRMMembership, chain?: any) {
    const params: any = {
      records: [membership],
    };
    if (chain) {
      params.chain = chain;
    }
    // If an ID is provided, CiviCRM's 'save' action will perform an update.
    // Otherwise, it will create a new record.
    return this.apiRequest('Membership', 'save', params);
  }

  /**
   * Explicitly record a membership activity (Signup or Renewal) to ensure 
   * CiviCRM dashboard statistics (CiviMember summary) are correctly updated.
   */
  public async recordMembershipActivity(params: {
    membershipId: number;
    contactId: number;
    activityType: 'Signup' | 'Renewal';
    date: string;
    contributionId?: number;
    subject?: string;
  }) {
    if (this.preview) {
      console.log(`Preview: Recording Activity type ${params.activityType} for membership ${params.membershipId}`);
      return;
    }

    // Dynamically resolve IDs to avoid environment mismatches
    const typeName = params.activityType === 'Signup' ? 'Membership Signup' : 'Membership Renewal';
    const activityTypeId = await this.getActivityTypeId(typeName);

    const activityValues: any = {
      activity_type_id: activityTypeId,
      activity_date_time: params.date,
      subject: params.subject || typeName,
      status_id: 2, // Completed
      source_record_id: params.membershipId,
      source_contact_id: process.env.CIVICRM_SYNC_USER_ID ? parseInt(process.env.CIVICRM_SYNC_USER_ID, 10) : 5, // Sync User
    };

    // Link contact as target
    const activityInfo = await this.apiRequest('Activity', 'create', {
      values: activityValues,
      chain: {
        link_contact: ['ActivityContact', 'create', {
          values: {
            activity_id: '$id',
            contact_id: params.contactId,
            record_type_id: 3, // Target
          }
        }],
        link_source: ['ActivityContact', 'create', {
          values: {
            activity_id: '$id',
            contact_id: process.env.CIVICRM_SYNC_USER_ID ? parseInt(process.env.CIVICRM_SYNC_USER_ID, 10) : 5, // Sync User
            record_type_id: 2, // Source
          }
        }]
      }
    });

    return activityInfo;
  }

  /**
   * Associate an existing contribution with a membership by updating the contribution record.
   * This helps CiviCRM create the membership-payment link and renewal activities when contributions
   * are back-dated into an existing membership period.
   */
  public async linkContributionToMembership(contributionId: number, membershipId: number) {
    if (!contributionId || !membershipId) throw new Error('contributionId and membershipId are required');
    if (this.preview) {
      console.log('Preview: Contribution.save (link membership)', { contributionId, membershipId });
      return { values: [{ id: contributionId }], updated: true };
    }
    return this.apiRequest('Contribution', 'save', {
      records: [{ id: contributionId, membership_id: membershipId }],
    });
  }

  public async deleteMembership(membershipId: number) {
    if (!membershipId) throw new Error('membershipId is required');
    if (this.preview) {
      console.log('Preview: Membership.delete', { id: membershipId });
      return { values: [{ id: membershipId }], deleted: true };
    }
    // CiviCRM supports a 'delete' action on entities via API4
    return this.apiRequest('Membership', 'delete', {
      where: [['id', '=', membershipId]],
    });
  }

  private relationshipTypeIdCache: { [name: string]: number } = {};

  public async getRelationshipTypeId(name: string): Promise<number> {
    if (this.relationshipTypeIdCache[name]) {
      return this.relationshipTypeIdCache[name];
    }

    // Handle the case where the relationship may have been renamed.
    const possibleNames = (name === 'Emergency Contact Of')
      ? ['Emergency Contact Of', 'Emergency Contact is']
      : [name];

    const result = await this.apiRequest('RelationshipType', 'get', {
      select: ['id'],
      where: [['label_a_b', 'IN', possibleNames]],
      limit: 1,
    });
    if (result && result.count > 0) {
      const id = result.values[0].id;
      // Cache the result under the original key for future calls.
      this.relationshipTypeIdCache[name] = id;
      return id;
    }
    throw new Error(`Could not find a relationship type with labels: "${possibleNames.join('" or "')}" in CiviCRM.`);
  }

  public async saveRelationship(contact_id_a: number, contact_id_b: number, relationship_type_id: number) {
    const params = {
      records: [{
        contact_id_a,
        contact_id_b,
        relationship_type_id,
        is_active: true,
      }],
      match: ['contact_id_a', 'contact_id_b', 'relationship_type_id'],
    };
    if (this.preview) {
      console.log('Preview: Relationship.save', { params });
      return { values: [{ id: -1 }] };
    }
    return this.apiRequest('Relationship', 'save', params);
  }

  private provinceIdCache: { [name: string]: number } = {};

  private locationTypeIdCache: { [name: string]: number } = {};

  public async getLocationTypeId(name: string): Promise<number | null> {
    if (this.locationTypeIdCache[name]) return this.locationTypeIdCache[name];
    const result = await this.apiRequest('LocationType', 'get', {
      select: ['id', 'name', 'display_name', 'is_default'],
      where: [['name', '=', name]],
      limit: 1,
    });
    if (result && result.count > 0) {
      const id = result.values[0].id;
      this.locationTypeIdCache[name] = id;
      return id;
    }
    return null;
  }

  private membershipTypeCache: { [id: number]: any } = {};

  /**
   * Get membership type details (duration_unit, duration_interval, period_type, fixed_period_*)
   * Caches results for the lifetime of the process.
   */
  public async getMembershipTypeDetails(membershipTypeId: number): Promise<any | null> {
    if (!membershipTypeId) return null;
    if (this.membershipTypeCache[membershipTypeId]) return this.membershipTypeCache[membershipTypeId];

    const result = await this.apiRequest('MembershipType', 'get', {
      select: ['id', 'name', 'duration_unit', 'duration_interval', 'period_type', 'fixed_period_start_day', 'fixed_period_rollover_day'],
      where: [['id', '=', membershipTypeId]],
      limit: 1,
    });

    if (result && result.count > 0) {
      this.membershipTypeCache[membershipTypeId] = result.values[0];
      return result.values[0];
    }
    return null;
  }

  public async getMembershipPaymentsForMembership(membershipId: number) {
    if (!membershipId) return [];
    try {
      const result = await this.apiRequest('MembershipPayment', 'get', {
        select: ['id', 'membership_id', 'contribution_id'],
        where: [['membership_id', '=', membershipId]],
      });
      return result && result.count ? result.values : [];
    } catch (err) {
      // If the API doesn't expose this entity, just return an empty array
      return [];
    }
  }

  public async createMembershipPayment(membershipId: number, contributionId: number) {
    if (!membershipId || !contributionId) throw new Error('membershipId and contributionId are required');
    if (this.preview) {
      console.log('Preview: MembershipPayment.create', { membershipId, contributionId });
      return { values: [{ id: -1 }], created: true };
    }
    return this.apiRequest('MembershipPayment', 'create', {
      values: [{ membership_id: membershipId, contribution_id: contributionId }],
    });
  }

  /**
   * Find activities that are likely associated with a specific membership.
   * Strategy:
   * 1) Search for activities with source_record_id = membershipId
   * 2) If none found, search for 'Membership Signup' or 'Membership Renewal' activities
   *    linked to the contact with a matching join_date/start_date (date match)
   * 3) As a last resort, search for activities containing our unique 'squarespace-renewal-for-contribution-' key
   */
  public async getActivitiesForMembership(membershipId: number, contactId: number, joinDate?: string) {
    if (!membershipId) return [];

    // 1) Try direct source_record_id link
    try {
      const direct = await this.apiRequest('Activity', 'get', {
        select: ['id', 'activity_type_id', 'activity_date_time', 'details'],
        where: [['source_record_id', '=', membershipId]],
      });
      if (direct && direct.count > 0) return direct.values;
    } catch (err) {
      // swallow and continue with fallback searches
    }

    // 2) Try contact+activity type+date based heuristics
    const activityTypeIds: number[] = [];
    try { activityTypeIds.push(await this.getActivityTypeId('Membership Signup')); } catch (e) { }
    try { activityTypeIds.push(await this.getActivityTypeId('Membership Renewal')); } catch (e) { }

    const where: any[] = [];
    where.push(['activity_contact.contact_id', '=', contactId]);
    where.push(['activity_contact.record_type_id', '=', 3]); // Activity Targets
    if (activityTypeIds.length > 0) where.push(['activity_type_id', 'IN', activityTypeIds]);
    if (joinDate) {
      // match by date prefix (activity_date_time is a timestamp)
      where.push(['activity_date_time', 'LIKE', `${joinDate}%`]);
    }

    try {
      const found = await this.apiRequest('Activity', 'get', {
        select: ['id', 'activity_type_id', 'activity_date_time', 'details'],
        join: [['ActivityContact AS activity_contact', 'LEFT', ['id', '=', 'activity_contact.activity_id']]],
        where,
        orderBy: { activity_date_time: 'DESC' },
      });
      if (found && found.count > 0) return found.values;
    } catch (err) {
      // continue to last-resort search
    }

    // 3) Last-resort: search for our unique dedup key in details
    try {
      const fallback = await this.apiRequest('Activity', 'get', {
        select: ['id', 'activity_type_id', 'activity_date_time', 'details'],
        where: [['details', 'LIKE', '%squarespace-renewal-for-contribution-%']],
        orderBy: { activity_date_time: 'DESC' },
      });
      if (fallback && fallback.count > 0) return fallback.values;
    } catch (err) {
      // nothing else
    }

    return [];
  }

  public async deleteActivity(activityId: number) {
    if (!activityId) throw new Error('activityId is required');
    if (this.preview) {
      console.log('Preview: Activity.delete', { id: activityId });
      return { values: [{ id: activityId }], deleted: true };
    }
    return this.apiRequest('Activity', 'delete', {
      where: [['id', '=', activityId]],
    });
  }

  public async getDefaultLocationTypeId(): Promise<number | null> {
    // Look for a location type with is_default = 1
    const result = await this.apiRequest('LocationType', 'get', {
      select: ['id', 'name', 'display_name', 'is_default'],
      where: [['is_default', '=', 1]],
      limit: 1,
    });
    if (result && result.count > 0) {
      return result.values[0].id;
    }
    return null;
  }

  public async getProvinceId(abbreviation: string): Promise<number | null> {
    if (this.provinceIdCache[abbreviation]) {
      return this.provinceIdCache[abbreviation];
    }
    const result = await this.apiRequest('StateProvince', 'get', {
      select: ['id'],
      where: [['abbreviation', '=', abbreviation]],
      limit: 1,
    });
    if (result && result.count > 0) {
      const id = result.values[0].id;
      this.provinceIdCache[abbreviation] = id;
      return id;
    }
    console.warn(`Could not find State/Province with abbreviation "${abbreviation}" in CiviCRM.`);
    return null;
  }

  public async savePhone(contactId: number, phoneNumber: string) {
    // First, set all other phones for this contact to non-primary
    await this.apiRequest('Phone', 'update', {
      where: [['contact_id', '=', contactId]],
      values: { is_primary: false },
    });

    const norm = this.normalizePhone(phoneNumber);
    const normalized = (norm && norm.normalized) || phoneNumber;
    const extension = (norm && norm.extension) ? norm.extension : null;

    const locationType = extension ? (await this.getLocationTypeId('Work') || (await this.getDefaultLocationTypeId() || 1)) : (await this.getDefaultLocationTypeId() || 1);

    // Now save the new phone number as primary, including extension when available
    if (this.preview) {
      console.log('Preview: Phone.save', { contactId, phoneNumber: normalized, extension });
      return { values: [{ id: -1 }] };
    }

    return this.apiRequest('Phone', 'save', {
      records: [{
        contact_id: contactId,
        location_type_id: locationType,
        phone: normalized,
        phone_type_id: 2, // Mobile
        phone_ext: extension,
        is_primary: true,
      }],
      match: ['contact_id', 'phone'],
    });
  }
}