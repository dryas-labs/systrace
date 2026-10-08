// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { root, loadConfig } from "./config.mjs";

export async function querySmoke() {
  const config = await loadConfig();
  await mkdir(resolve(root, ".tmp"), { recursive: true });
  const project = await mkdtemp(resolve(root, ".tmp/query-smoke-"));
  await cp(resolve(root, "test/fixtures/model-queries/model"), resolve(project, "model"), {
    recursive: true,
  });
  const client = new Client({ name: "dryas-query-smoke", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(root, "packages/mcp-server/dist/cli.cjs"),
      "--project",
      project,
      "--engine",
      config.engine.apiPath,
    ],
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, `${name} failed: ${response.content?.[0]?.text}`);
    return response.structuredContent;
  };
  const describe = async (name, inherited = false) =>
    (await call("describe_element", { qualifiedName: name, includeInherited: inherited })).items[0];
  const has = (values, id) => values.items.some((e) => e.qualifiedName === id);
  let probes = 0;
  try {
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      ["validate", "find_element", "describe_element", "library_lookup"],
    );
    const validation = await call("validate", {});
    assert.equal(
      validation.project.errors,
      0,
      "Query fixture must validate before evaluating query assertions.",
    );
    const drone = await describe("Vehicle::Drone");
    assert.equal(drone.element.kind, "PartDefinition");
    assert(drone.generalizations.some((r) => r.target === "Definitions::Component"));
    probes++;
    const component = await describe("Definitions::Component");
    assert(component.generalizations.some((r) => r.target === "Parts::Part" && r.implicit));
    probes++;
    const battery = await describe("Definitions::Battery", true);
    assert(battery.element.documentation.includes("supplying electrical power"));
    assert(
      battery.features.some(
        (f) =>
          f.name === "power" &&
          f.types.includes("Definitions::PowerPort") &&
          f.inheritedFrom === "Definitions::PowerSource",
      ),
    );
    assert(
      battery.features.some(
        (f) => f.name === "mass" && f.inheritedFrom === "Definitions::Component",
      ),
    );
    assert(battery.features.some((f) => f.name === "capacity" && f.inheritedFrom === null));
    probes++;
    const typed = await describe("Vehicle::Drone::battery");
    assert(typed.typedBy.includes("Definitions::Battery"));
    probes++;
    const specializations = await call("find_element", {
      specializes: "Definitions::Component",
      limit: 500,
    });
    for (const id of [
      "Definitions::PowerSource",
      "Definitions::Battery",
      "Power::Motor",
      "Vehicle::Drone",
    ])
      assert(has(specializations, id));
    assert(!has(specializations, "Definitions::PowerPort"));
    probes++;
    const library = await call("library_lookup", { qualifiedName: "Parts::Part" });
    assert.equal(library.source, "bundled-library");
    assert.equal(library.content.projectRevision, null);
    assert.equal(library.items[0].element.kind, "PartDefinition");
    probes++;
    assert(
      drone.relationships.some(
        (r) => r.kind === "connect" && r.source === null && r.target === null,
      ),
    );
    probes++;
    assert(
      (await describe("DroneRequirements")).relationships.some(
        (r) => r.kind === "satisfy" && r.target === "DroneRequirements::droneMass",
      ),
    );
    probes++;
    const brake = await describe("BrakeSystem::brakeResponse");
    assert(
      brake.metadata.some(
        (m) =>
          m.type === "SafetyExtensions::Rationale" &&
          !m.semantic &&
          m.values.approvedBy?.value === "Systems Lead",
      ),
    );
    probes++;
    const selected = await call("find_element", {
      metadata: { type: "SafetyExtensions::Rationale", values: { approvedBy: "Chief Engineer" } },
    });
    assert(has(selected, "BrakeSystem::stopDistance"));
    assert(!has(selected, "BrakeSystem::brakeResponse") && !has(selected, "BrakeSystem::comfort"));
    probes++;
    const safety = await call("find_element", {
      metadata: { type: "SafetyExtensions::SafetyRequirementMetadata" },
    });
    assert(has(safety, "BrakeSystem::stopDistance") && has(safety, "BrakeSystem::brakeResponse"));
    assert(!has(safety, "BrakeSystem::comfort"));
    probes++;
    const stop = await describe("BrakeSystem::stopDistance");
    assert(
      stop.generalizations.some(
        (r) => r.target === "SafetyExtensions::safetyRequirements" && r.semanticMetadataImplicit,
      ),
    );
    assert(
      stop.metadata.some(
        (m) =>
          m.type === "SafetyExtensions::SafetyRequirementMetadata" &&
          m.semantic &&
          m.keyword === "safety",
      ),
    );
    probes++;

    const exactName = await call("find_element", {
      name: "Battery",
      kind: "PartDefinition",
      scope: ["Definitions"],
    });
    assert.equal(exactName.total, 1);
    assert.equal(exactName.content.projectRevision, validation.content.projectRevision);
    const first = await call("find_element", { scope: ["Definitions"], limit: 1 });
    assert(first.nextCursor);
    const second = await call("find_element", { cursor: first.nextCursor, limit: 1 });
    assert.notEqual(first.items[0].id, second.items[0].id);
    const badCursor = await client.callTool({
      name: "library_lookup",
      arguments: { cursor: first.nextCursor },
    });
    assert(badCursor.isError);
    const alias = await describe("Controls::aliasUse");
    assert(alias.metadata.some((m) => m.keyword === "secure"));
    const body = await describe("Controls::bodyOnly");
    assert(body.metadata.some((m) => m.semantic && !m.prefix && m.keyword === null));
    const mixed = await describe("Controls::mixed");
    assert.equal(
      mixed.metadata.filter((m) => m.type === "SafetyExtensions::SafetyRequirementMetadata").length,
      2,
    );
    const reviewers = await call("find_element", {
      scope: ["Controls"],
      metadata: { type: "SafetyExtensions::Review", values: { reviewer: "Lead", approved: true } },
    });
    assert(has(reviewers, "Controls::AcceptedReview"));
    assert(!has(reviewers, "Controls::SplitReviews"), "Predicates must match the same annotation.");
    assert.equal(
      (await describe("Controls::'Quoted Name'")).metadata[0].values.approvedBy.value,
      "Quoted",
    );
    const voltage = await call("library_lookup", { qualifiedName: "ISQ::voltage" });
    assert.equal(voltage.items[0].element.qualifiedName, "ISQElectromagnetism::voltage");
    assert(voltage.items[0].element.documentation.includes("electric tension"));
    const browse = await call("library_lookup", { namespace: "ScalarValues", name: "Integer" });
    assert(has(browse, "ScalarValues::Integer"));
    const missing = await client.callTool({
      name: "describe_element",
      arguments: { qualifiedName: "Definitions::Missing" },
    });
    assert(missing.isError);
    assert(
      has(await call("find_element", { name: "Battery" }), "Definitions::Battery"),
      "Rejected query must not destroy the transport.",
    );
    const file = resolve(project, "model/definitions.sysml");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("part def Battery", "part def BatteryRenamed"),
    );
    const stale = await client.callTool({
      name: "find_element",
      arguments: { cursor: first.nextCursor },
    });
    assert(stale.isError);
    const renamed = await call("find_element", { name: "BatteryRenamed" });
    assert(has(renamed, "Definitions::BatteryRenamed"));
    assert(renamed.content.projectRevision > validation.content.projectRevision);
    assert.equal(renamed.validation.status, "errors", "Queries must retain model-error context.");
    await writeFile(
      resolve(project, "model/shadow.sysml"),
      "package Parts { part def Part { attribute projectOnly; } }\n",
    );
    const isolated = await call("library_lookup", { qualifiedName: "Parts::Part" });
    assert(!isolated.items[0].features.some((f) => f.name === "projectOnly"));
    assert.equal(probes, 12);
    console.log(
      "Native MCP query checks passed: 12 migrated probe contracts, metadata controls, library isolation, pagination, edits and recovery.",
    );
  } finally {
    await client.close();
  }
}

await querySmoke();
