export interface SquarespaceAddress {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  countryCode: string;
  postalCode: string;
  phone: string;
}

export interface SquarespaceProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  address: SquarespaceAddress | null;
  phone: string | null;
  hasAccount: boolean;
  isCustomer: boolean;
  createdOn: string;
  acceptsMarketing: boolean;
}

export interface SquarespaceMoney {
  value: string;
  currency: string;
}

export interface SquarespaceLineItem {
  id: string;
  variantId: string | null;
  sku: string | null;
  productName: string;
  quantity: number;
  unitPricePaid: SquarespaceMoney;
  customizations: { label: string; value: string }[] | null;
}

export interface SquarespaceOrder {
  id: string;
  orderNumber: string;
  createdOn: string;
  customerEmail: string;
  billingAddress: SquarespaceAddress;
  lineItems: SquarespaceLineItem[];
  grandTotal: SquarespaceMoney;
}

export interface SquarespaceTransaction {
  id: string;
  createdOn: string;
  modifiedOn: string;
  salesOrderId: string | null;
  customerEmail: string;
  total: SquarespaceMoney;
  payments: {
    id: string;
    amount: SquarespaceMoney;
    creditCardType: string | null;
    provider: string | null;
    externalTransactionId: string;
    processingFees?: {
      id: string;
      amount: SquarespaceMoney;
      amountGatewayCurrency?: SquarespaceMoney;
      refundedAmount?: SquarespaceMoney;
      netAmount?: SquarespaceMoney;
    }[];
  }[];
}

export interface CiviCRMContact {
  id?: number;
  contact_type?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  external_identifier?: string;
  created_date?: string;
}

export interface CiviCRMContribution {
  id?: number;
  contact_id: number;
  membership_id?: number;
  financial_type_id: number;
  payment_instrument_id?: number;
  contribution_status_id?: number;
  payment_processor_id?: number;
  total_amount: number;
  currency: string;
  trxn_id: string;
  invoice_id: string;
  source: string;
  receive_date: string;
  fee_amount?: number;
  non_deductible_amount?: number;
}

export interface CiviCRMMembership {
  id?: number;
  contact_id?: number;
  membership_type_id?: number;
  join_date?: string;
  start_date?: string;
  end_date?: string;
  source?: string;
  status_id?: number;
  auto_renew?: number;
  is_override?: boolean;
}

export interface CiviCRMLineItem {
  id?: number;
  label: string;
  qty: number;
  unit_price: number;
  line_total: number;
  financial_type_id: number;
  price_field_value_id?: number;
  entity_table?: string;
  entity_id?: number;
  params?: any;
}

export interface CiviCRMOrder {
  contributionValues: Partial<CiviCRMContribution> & { contact_id: number };
  lineItems: CiviCRMLineItem[];
}