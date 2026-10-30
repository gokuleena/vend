// Tenant verification providers. A provider has { name, start(verification) }.
// "manual" (default): the landlord asks the tenant for ID outside Vend, an admin reviews it and records VERIFIED or REJECTED.
// Vend stores only the tenant's name, the last 4 phone digits, the status and a short note. It never stores ID numbers or documents.
//
// To plug in a licensed KYC provider (for example a DigiLocker-based or e-KYC vendor), you need a contract and their API docs. Then add an entry:
//   providers.acme = { name: "acme", async start(v) { /* create a hosted verification session, return { mode: "link", url } */ } }
// and set VERIFY_PROVIDER=acme. Their webhook should call a new route that sets status to VERIFIED or REJECTED.
export const providers = {
  manual: {
    name: "manual",
    async start() {
      return { mode: "manual", steps: ["Ask the tenant to show a government ID on a video call or in person (do not collect or store the number).",
        "Check employer or income proof and a reference from the previous landlord.", "Submit this request; a Vend admin records the result.",
        "Complete police verification as your city requires."] };
    },
  },
};
export const provider = providers[process.env.VERIFY_PROVIDER || "manual"] || providers.manual;
