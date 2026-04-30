import axios, { AxiosInstance } from 'axios';

interface AmountInput {
    value: number;
    currency: string;
}

interface AccountReferenceInput {
    slug?: string;
    email?: string; // Future use
    id?: string;
    legacyId?: number;
}

export interface AddFundsResult {
    id: string;
    status: string;
    description: string;
    legacyId?: number;
    fromAccount?: {
        slug: string;
        name: string;
    }
}

export class OpenCollective {
    private client: AxiosInstance;
    private apiUrl: string;
    private apiKey: string;
    private targetSlug: string;
    private importerSlug: string;
    private dryRun: boolean;

    constructor(
        apiKey: string,
        targetSlug: string,
        importerSlug: string = 'cpd',
        dryRun: boolean = false,
        apiUrl: string = 'https://api.opencollective.com/graphql/v2'
    ) {
        this.apiKey = apiKey;
        this.targetSlug = targetSlug;
        this.importerSlug = importerSlug;
        this.apiUrl = apiUrl;
        this.dryRun = dryRun;

        this.client = axios.create({
            baseURL: this.apiUrl,
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Api-Key': this.apiKey, // Required for Personal Tokens
                'Content-Type': 'application/json'
            }
        });
    }

    async addFunds(
        amount: number,
        currency: string,
        originalDonorName: string,
        originalDonorEmail: string,
        description: string,
        date?: string // Optional date override if API supports it (often it doesn't for addFunds easily without host privs, but we'll see)
    ): Promise<AddFundsResult | null> {

        // Construct the effective description including attribution
        const attributionNote = `[Imported from Squarespace] Donor: ${originalDonorName} <${originalDonorEmail}>`;
        const fullDescription = `${description}\n\n${attributionNote}`;

        const mutation = `
            mutation($amount: AmountInput!, $fromAccount: AccountReferenceInput!, $account: AccountReferenceInput!, $description: String!) {
                addFunds(
                    amount: $amount
                    fromAccount: $fromAccount
                    account: $account 
                    description: $description
                ) {
                    id
                    status
                    description
                    legacyId
                    fromAccount {
                        slug
                        name
                    }
                }
            }
        `;

        const variables = {
            amount: { value: amount, currency: currency },
            fromAccount: { slug: this.importerSlug }, // Use fallback/importer account
            account: { slug: this.targetSlug },
            description: fullDescription
        };

        if (this.dryRun) {
            console.log(`[DRY-RUN] Would add funds to ${this.targetSlug}:`);
            console.log(`   Amount: ${amount} ${currency}`);
            console.log(`   From: ${this.importerSlug} (Proxy for ${originalDonorName})`);
            console.log(`   Desc: ${fullDescription}`);
            return null;
        }

        try {
            const response = await this.client.post('', { query: mutation, variables });

            if (response.data.errors) {
                console.error(`[OpenCollective] Add Funds Error:`, JSON.stringify(response.data.errors, null, 2));
                throw new Error(response.data.errors[0].message);
            }

            const result = response.data.data.addFunds;
            console.log(`[OpenCollective] Funds Added! Transaction ID: ${result.id}`);
            return result;

        } catch (error: any) {
            console.error(`[OpenCollective] Request Failed: ${error.message}`);
            if (error.response) {
                console.error('[OpenCollective] Details:', JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }
    }

    // Future method for when permission is granted
    /* 
    async getAccountByEmail(email: string): Promise<any> {
       // ... implementation ...
    }
    */
}
