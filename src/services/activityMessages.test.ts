import { describe, expect, it } from "vitest";
import type { ActivityEntry, ActivityEventType } from "../domain/types";
import { describeActivity, describeActor } from "./activityMessages";

const names = new Map([
  ["actor-1", "ada.lovelace"],
  ["member-1", "grace.hopper"],
]);

function entry(type: ActivityEventType | string, metadata: Record<string, unknown> = {}): ActivityEntry {
  return {
    id: "event-1",
    investigationId: "inv-1",
    actorId: "actor-1",
    type: type as ActivityEventType,
    metadata,
    occurredAt: "2026-08-09T09:00:00.000Z",
  };
}

describe("describeActivity", () => {
  it("names the entity and leaves the reference to the link beside it", () => {
    // Printing both stutters: "opened INV-ABC123 for Northwind Traders INV-ABC123".
    expect(describeActivity(entry("investigation-created", { reference: "INV-ABC123", entity: "Northwind Traders" })))
      .toBe("opened a case for Northwind Traders");
  });

  it("falls back to the reference when the entity is missing", () => {
    expect(describeActivity(entry("investigation-created", { reference: "INV-ABC123" })))
      .toBe("opened INV-ABC123");
  });

  it("describes an upload by filename", () => {
    expect(describeActivity(entry("upload-created", { original_name: "ledger.csv" })))
      .toBe("uploaded ledger.csv");
  });

  it("describes the three parse states", () => {
    expect(describeActivity(entry("parse-started"))).toBe("started parsing the upload");
    expect(describeActivity(entry("parse-completed", { rowCount: 42, warningCount: 0 }))).toBe("parsed 42 records");
    expect(describeActivity(entry("parse-failed"))).toBe("could not parse the upload");
  });

  it("mentions skipped rows only when there were any", () => {
    expect(describeActivity(entry("parse-completed", { rowCount: 42, warningCount: 3 })))
      .toBe("parsed 42 records, 3 skipped");
    expect(describeActivity(entry("parse-completed", { rowCount: 1, warningCount: 0 })))
      .toBe("parsed 1 record");
  });

  it("names the member a membership event is about", () => {
    expect(describeActivity(entry("member-invited", { member_user_id: "member-1" }), names))
      .toBe("invited grace.hopper");
    expect(describeActivity(entry("member-activated", { member_user_id: "member-1" }), names))
      .toBe("activated grace.hopper");
    expect(describeActivity(entry("member-invite-rejected", { member_user_id: "member-1" }), names))
      .toBe("rejected the invitation for grace.hopper");
  });

  it("describes a role change in both directions", () => {
    expect(describeActivity(entry("member-role-changed", { member_user_id: "member-1", from: "analyst", to: "manager" }), names))
      .toBe("changed grace.hopper from analyst to manager");
  });

  it("degrades when metadata is missing rather than printing undefined", () => {
    expect(describeActivity(entry("investigation-created"))).toBe("opened an investigation");
    expect(describeActivity(entry("upload-created"))).toBe("uploaded a file");
    expect(describeActivity(entry("parse-completed"))).toBe("finished parsing the upload");
    expect(describeActivity(entry("member-role-changed", { member_user_id: "member-1" }), names))
      .toBe("changed the role of grace.hopper");
    expect(describeActivity(entry("member-activated"))).toBe("activated a member");
  });

  it("falls back to a member fragment when the roster does not cover them", () => {
    expect(describeActivity(entry("member-activated", { member_user_id: "5e2de68d-f422-40bd" }), names))
      .toBe("activated Member 5e2de68d");
  });

  it("stays readable for an event type it has never seen", () => {
    // The CHECK constraint can gain a value before this map does.
    expect(describeActivity(entry("case-approved"))).toBe("case approved");
  });
});

describe("describeActor", () => {
  it("names a known actor", () => {
    expect(describeActor(entry("parse-started"), names)).toBe("ada.lovelace");
  });

  it("falls back to a fragment for an actor the roster does not cover", () => {
    expect(describeActor({ ...entry("parse-started"), actorId: "b392d507-a0f0" }, names)).toBe("Member b392d507");
  });

  it("attributes an actorless event to the system", () => {
    // actor_id is nullable, and a service-role write leaves it null.
    expect(describeActor({ ...entry("parse-completed"), actorId: null }, names)).toBe("The system");
  });
});
