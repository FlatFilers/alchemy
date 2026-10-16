import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import * as acm from "@distilled.cloud/aws/acm";
import type { Providers } from "../Providers.ts";
import { regionOfCertificateArn, withCertRegion } from "./Certificate.ts";

export interface CertificateValidationProps {
  /**
   * ARN of the certificate to wait for. Usually the `certificateArn`
   * attribute of an `AWS.ACM.Certificate` created with `hostedZoneId`
   * omitted (validation records written by the caller, e.g. through a DNS
   * provider for a zone that does not live in Route 53).
   *
   * Changing this replaces the resource.
   */
  certificateArn: string;
}

export interface CertificateValidationAttributes {
  /**
   * The validated certificate's ARN — pass this to whatever consumes the
   * certificate (a CloudFront distribution, an ALB listener, …). Reading it
   * is what makes the consumer wait for issuance.
   */
  certificateArn: string;
  /**
   * Status observed when validation completed. Always `ISSUED` on success.
   */
  status: string;
}

export type CertificateValidation = Resource<
  "AWS.ACM.CertificateValidation",
  CertificateValidationProps,
  CertificateValidationAttributes,
  never,
  Providers
>;

/**
 * Waits for an ACM certificate to reach `ISSUED`.
 *
 * Exists because a certificate whose DNS validation records live outside
 * Route 53 cannot be validated by `AWS.ACM.Certificate` itself: that resource
 * returns the certificate **pending** when it has no `hostedZoneId`, so that
 * the caller can write the validation records first. This resource is the
 * second half of that pair — it depends on those records (via the reference
 * you pass) and blocks until ACM reports the certificate issued, so
 * downstream consumers never see a pending certificate.
 *
 * The same shape as Terraform's `aws_acm_certificate_validation`.
 *
 * ### Validating a certificate with records in a non-Route53 zone
 * **Example:** Certificate + external DNS records + validation
 * ```typescript
 * const cert = yield* AWS.ACM.Certificate("Cert", {
 *   domainName: "app.example.com",
 *   // no hostedZoneId: the zone lives in Vercel, not Route 53
 * });
 *
 * // Write ACM's validation CNAMEs wherever the zone actually lives.
 * yield* Effect.forEach(
 *   cert.domainValidationOptions,
 *   (option) =>
 *     option.ResourceRecord
 *       ? Vercel.Record(`Validation${option.ResourceRecord.Name}`, {
 *           domain: "example.com",
 *           name: option.ResourceRecord.Name,
 *           type: option.ResourceRecord.Type,
 *           value: option.ResourceRecord.Value,
 *         })
 *       : Effect.void,
 *   { discard: true },
 * );
 *
 * // Block until ACM sees them and issues.
 * const validation = yield* AWS.ACM.CertificateValidation("CertValidation", {
 *   certificateArn: cert.certificateArn,
 * });
 *
 * // A consumer of `validation.certificateArn` is created only after issuance.
 * ```
 *
 * Deletion is a no-op: this resource owns no AWS object — the certificate is
 * owned by `AWS.ACM.Certificate`.
 *
 * @resource
 */
export const CertificateValidation = Resource<CertificateValidation>(
  "AWS.ACM.CertificateValidation",
);

class CertificateValidationFailed extends Error {}

const isTerminalFailure = (
  status: acm.CertificateStatus | undefined,
): boolean =>
  status === "FAILED" ||
  status === "VALIDATION_TIMED_OUT" ||
  status === "REVOKED";

const describe = Effect.fn(function* (certificateArn: string) {
  return yield* acm
    .describeCertificate({ CertificateArn: certificateArn })
    .pipe(
      Effect.map((response) => response.Certificate),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
      withCertRegion(regionOfCertificateArn(certificateArn)),
    );
});

/**
 * Poll every 10s for up to 30 minutes. ACM DNS validation typically
 * completes in seconds once the records exist; the long tail covers slow
 * DNS propagation.
 */
const validationSchedule = Schedule.max([
  Schedule.fixed("10 seconds"),
  Schedule.recurs(180),
]);

const waitForIssued = Effect.fn(function* (certificateArn: string) {
  return yield* describe(certificateArn).pipe(
    Effect.flatMap((detail) => {
      if (detail === undefined || detail.CertificateArn === undefined) {
        return Effect.fail(
          new CertificateValidationFailed(
            `Certificate ${certificateArn} was not found; it may have been deleted`,
          ),
        );
      }
      if (detail.Status === "ISSUED") {
        return Effect.succeed(detail);
      }
      if (isTerminalFailure(detail.Status)) {
        return Effect.fail(
          new CertificateValidationFailed(
            `Certificate ${certificateArn} reached ${detail.Status}${
              detail.FailureReason ? ` (${detail.FailureReason})` : ""
            }`,
          ),
        );
      }
      return Effect.fail(
        new CertificateValidationFailed(
          `Certificate ${certificateArn} is still ${detail.Status ?? "PENDING_VALIDATION"}`,
        ),
      );
    }),
    Effect.retry({
      // Retry pending states; never retry a terminal failure or a missing cert.
      while: (error) =>
        error instanceof CertificateValidationFailed &&
        error.message.includes("is still"),
      schedule: validationSchedule,
    }),
  );
});

export const CertificateValidationProvider = () =>
  Provider.succeed(CertificateValidation, {
    stables: ["certificateArn"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.certificateArn !== output.certificateArn) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const detail = yield* describe(output.certificateArn);
      if (detail?.Status !== "ISSUED") return undefined;
      return {
        certificateArn: output.certificateArn,
        status: detail.Status,
      } satisfies CertificateValidationAttributes;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const certificateArn = news.certificateArn ?? output?.certificateArn;
      if (certificateArn === undefined || certificateArn === "") {
        return yield* Effect.fail(
          new CertificateValidationFailed(
            "certificateArn is required (pass the AWS.ACM.Certificate's certificateArn)",
          ),
        );
      }
      const detail = yield* waitForIssued(certificateArn);
      return {
        certificateArn,
        status: detail.Status ?? "ISSUED",
      } satisfies CertificateValidationAttributes;
    }),
    // Owns no AWS object: the certificate belongs to AWS.ACM.Certificate.
    delete: Effect.fn(function* () {}),
  });
