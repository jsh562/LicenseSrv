// T043 [US5] (FR-013): the domain/email-sender verification state machine as a PURE unit — no DB, no real
// network. Asserts the load-bearing US5 rules the DomainVerifier + routes compose (AD-006, INV-5/6):
//   - the pending→verified→active state machine (decideVerify / decideActivate): verify-before-activate,
//     idempotent no-ops, and the pending→activate refusal.
//   - method-per-type: a domain uses DNS TXT/CNAME, an email sender uses SPF+DKIM/DMARC (methodMatchesKind /
//     defaultMethod / buildChallengeRecords), mirroring the DB method-shape CHECK.
//   - host normalization (normalizeHost / emailSenderDomain): trim, lower-case, strip trailing dot, IDNA/punycode.
//   - the DNS challenge check driven by an INJECTED stub resolver (deterministic, network-free).
import { describe, expect, it } from "vitest";

import {
  buildChallengeRecords,
  checkDnsChallenge,
  decideActivate,
  decideVerify,
  defaultMethod,
  type DnsResolver,
  emailSenderDomain,
  kindToBindingType,
  bindingTypeToKind,
  methodMatchesKind,
  normalizeHost,
} from "../verify.js";

/** A deterministic in-memory DNS stub — TXT/CNAME records keyed by name; missing names REJECT like node:dns. */
function stubResolver(records: { txt?: Record<string, string[]>; cname?: Record<string, string[]> }): DnsResolver {
  return {
    async resolveTxt(name: string): Promise<string[][]> {
      const v = records.txt?.[name];
      if (!v) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      return v.map((s) => [s]); // each record a single chunk
    },
    async resolveCname(name: string): Promise<string[]> {
      const v = records.cname?.[name];
      if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return v;
    },
  };
}

describe("verification state machine (unit)", () => {
  it("decideVerify: pending checks DNS; verified/active are idempotent no-ops", () => {
    expect(decideVerify("pending")).toBe("check_dns");
    expect(decideVerify("verified")).toBe("noop");
    expect(decideVerify("active")).toBe("noop");
  });

  it("decideActivate: verified activates; active is a no-op; pending is refused (not_verified)", () => {
    expect(decideActivate("verified")).toBe("activate");
    expect(decideActivate("active")).toBe("noop");
    expect(decideActivate("pending")).toBe("reject_not_verified");
  });
});

describe("method-per-type (unit)", () => {
  it("maps kind ↔ binding_type both ways", () => {
    expect(kindToBindingType("domain")).toBe("custom_domain");
    expect(kindToBindingType("email_sender")).toBe("email_sender");
    expect(bindingTypeToKind("custom_domain")).toBe("domain");
    expect(bindingTypeToKind("email_sender")).toBe("email_sender");
  });

  it("defaults a domain to DNS TXT and an email sender to SPF+DKIM/DMARC", () => {
    expect(defaultMethod("domain")).toBe("dns_txt");
    expect(defaultMethod("email_sender")).toBe("spf_dkim_dmarc");
  });

  it("enforces the method-shape CHECK: domain=dns_txt|dns_cname, email=spf_dkim_dmarc", () => {
    expect(methodMatchesKind("domain", "dns_txt")).toBe(true);
    expect(methodMatchesKind("domain", "dns_cname")).toBe(true);
    expect(methodMatchesKind("domain", "spf_dkim_dmarc")).toBe(false);
    expect(methodMatchesKind("email_sender", "spf_dkim_dmarc")).toBe(true);
    expect(methodMatchesKind("email_sender", "dns_txt")).toBe(false);
  });

  it("builds a single TXT ownership record for a domain (dns_txt)", () => {
    const recs = buildChallengeRecords("domain", "licensing.acme.example", "dns_txt", "abc123");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ purpose: "domain_ownership", recordType: "TXT", name: "_licensing-challenge.licensing.acme.example" });
    expect(recs[0].value).toContain("abc123");
  });

  it("builds a CNAME ownership record for a domain (dns_cname)", () => {
    const recs = buildChallengeRecords("domain", "licensing.acme.example", "dns_cname", "abc123");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ purpose: "domain_ownership", recordType: "CNAME", name: "_licensing-challenge.licensing.acme.example" });
    expect(recs[0].value.startsWith("abc123")).toBe(true);
  });

  it("builds SPF + DKIM + DMARC records for an email sender", () => {
    const recs = buildChallengeRecords("email_sender", "acme.example", "spf_dkim_dmarc", "tok9");
    expect(recs.map((r) => r.purpose).sort()).toEqual(["dkim", "dmarc", "spf"]);
    expect(recs.find((r) => r.purpose === "spf")!.name).toBe("acme.example");
    expect(recs.find((r) => r.purpose === "dkim")!.name).toBe("licensing._domainkey.acme.example");
    expect(recs.find((r) => r.purpose === "dmarc")!.name).toBe("_dmarc.acme.example");
  });
});

describe("host normalization (unit)", () => {
  it("trims, lower-cases, and strips a trailing dot", () => {
    expect(normalizeHost("  Licensing.ACME.Example.  ")).toBe("licensing.acme.example");
  });

  it("converts Unicode/IDN labels to ASCII punycode (IDNA ToASCII)", () => {
    // bücher.example → xn--bcher-kva.example
    expect(normalizeHost("Bücher.Example")).toBe("xn--bcher-kva.example");
  });

  it("extracts + normalizes the sending domain from an email address", () => {
    expect(emailSenderDomain("Licensing@ACME.Example.")).toBe("acme.example");
    expect(emailSenderDomain("acme.example")).toBe("acme.example");
  });
});

describe("DNS challenge check with injected resolver (unit)", () => {
  it("a domain TXT challenge is MET when the exact record is published", async () => {
    const recs = buildChallengeRecords("domain", "licensing.acme.example", "dns_txt", "abc123");
    const dns = stubResolver({ txt: { "_licensing-challenge.licensing.acme.example": [recs[0].value] } });
    const check = await checkDnsChallenge(recs, dns);
    expect(check.met).toBe(true);
    expect(check.unmet).toHaveLength(0);
  });

  it("a domain TXT challenge is UNMET (and reported) when the record is absent", async () => {
    const recs = buildChallengeRecords("domain", "licensing.acme.example", "dns_txt", "abc123");
    const check = await checkDnsChallenge(recs, stubResolver({}));
    expect(check.met).toBe(false);
    expect(check.unmet).toHaveLength(1);
  });

  it("a CNAME challenge is MET when the target matches (trailing dot tolerant)", async () => {
    const recs = buildChallengeRecords("domain", "licensing.acme.example", "dns_cname", "abc123");
    const dns = stubResolver({ cname: { "_licensing-challenge.licensing.acme.example": [recs[0].value + "."] } });
    expect((await checkDnsChallenge(recs, dns)).met).toBe(true);
  });

  it("an email SPF+DKIM/DMARC challenge is MET only when ALL three align", async () => {
    const recs = buildChallengeRecords("email_sender", "acme.example", "spf_dkim_dmarc", "tok9");
    const dkim = recs.find((r) => r.purpose === "dkim")!;
    const full = stubResolver({
      txt: {
        "acme.example": ["v=spf1 include:_spf.licensing.example ~all"],
        "licensing._domainkey.acme.example": [dkim.value],
        "_dmarc.acme.example": ["v=DMARC1; p=none"],
      },
    });
    expect((await checkDnsChallenge(recs, full)).met).toBe(true);

    // Missing DMARC → unmet.
    const noDmarc = stubResolver({
      txt: {
        "acme.example": ["v=spf1 include:_spf.licensing.example ~all"],
        "licensing._domainkey.acme.example": [dkim.value],
      },
    });
    const partial = await checkDnsChallenge(recs, noDmarc);
    expect(partial.met).toBe(false);
    expect(partial.unmet.map((r) => r.purpose)).toContain("dmarc");
  });

  it("an SPF record WITHOUT the required include does not satisfy the challenge", async () => {
    const recs = buildChallengeRecords("email_sender", "acme.example", "spf_dkim_dmarc", "tok9");
    const dns = stubResolver({ txt: { "acme.example": ["v=spf1 include:_spf.other.example ~all"] } });
    const check = await checkDnsChallenge(recs, dns);
    expect(check.met).toBe(false);
    expect(check.unmet.map((r) => r.purpose)).toContain("spf");
  });
});
