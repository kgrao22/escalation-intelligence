import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildExtractionIndex } from "../adjudication/candidatePairs.js";
import type { RecurringIssueGroup, RecurringIssueMember } from "../groups/buildGroups.js";
import {
  assertDisjointIntegrity,
  buildDisjointCliqueCover,
  DisjointGroupIntegrityError,
  type SamePair,
} from "../groups/disjointCliqueCover.js";
import type { AdjudicationOutput } from "../persistence/adjudicationOutput.js";
import type { ExtractionOutput } from "../persistence/extractionOutput.js";
import type { GroupOutput } from "../persistence/groupOutput.js";
import { writeReportOutput, type ReportOutput } from "../persistence/reportOutput.js";
import type { WorkflowAdjudicationOutput } from "../persistence/workflowAdjudicationOutput.js";
import type { WorkflowClusterOutput } from "../persistence/workflowClusterOutput.js";
import { buildRecurringIssueReport } from "../report/buildReport.js";
import { tsToIso } from "../slack/escalationThreads.js";
import type { WorkflowCluster } from "../workflow/buildWorkflowClusters.js";
import { selectWorkflowEmbeddingCandidates } from "../workflow/workflowEmbeddingCandidates.js";

const DIR = path.resolve(process.cwd(), "data", "intelligence");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.resolve(process.cwd(), p), "utf8")) as T;
}

function iso(rootTs: string): string | null {
  const value = tsToIso(rootTs);
  return value === rootTs ? null : value;
}

function groupId(members: string[]): string {
  return `grp_v2_${(members[0] as string).replace(".", "")}`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      adjudications: { type: "string" },
      extractions: { type: "string" },
      "workflow-adjudications": { type: "string" },
      window: { type: "string" },
      date: { type: "string" },
    },
    strict: false,
  });

  const windowTag = String(values.window ?? "365d");
  const date = String(values.date ?? new Date().toISOString().slice(0, 10));

  const adjudication = await readJson<AdjudicationOutput>(String(values.adjudications));
  const extraction = await readJson<ExtractionOutput>(String(values.extractions));
  const workflowAdjudication = await readJson<WorkflowAdjudicationOutput>(
    String(values["workflow-adjudications"]),
  );

  // ---------- PART A: technical ----------
  const techSame: SamePair[] = [];
  const techDifferent: Array<{ a: string; b: string }> = [];
  for (const r of adjudication.results) {
    if (r.status !== "success") continue;
    if (r.relationship === "same_underlying_issue") {
      techSame.push({ a: r.a.rootTs, b: r.b.rootTs, confidence: r.confidence ?? 0 });
    } else if (r.relationship === "different") {
      techDifferent.push({ a: r.a.rootTs, b: r.b.rootTs });
    }
  }

  const techCover = buildDisjointCliqueCover(techSame);
  try {
    assertDisjointIntegrity(techCover.groups, techSame, techDifferent);
  } catch (err) {
    if (err instanceof DisjointGroupIntegrityError) fail(`✗ ${err.message}`);
    throw err;
  }

  const extractionIndex = buildExtractionIndex(extraction);
  const nameByPair = new Map<string, string>();
  for (const r of adjudication.results) {
    if (r.status === "success" && r.proposedRecurringIssueName) {
      nameByPair.set([r.a.rootTs, r.b.rootTs].sort().join("::"), r.proposedRecurringIssueName);
    }
  }

  const techGroups: RecurringIssueGroup[] = techCover.groups.map((g) => {
    const members: RecurringIssueMember[] = g.members.map((rootTs) => {
      const a = extractionIndex.get(rootTs);
      return {
        rootTs,
        normalizedProblemStatement: a?.normalizedProblemStatement ?? "",
        permalink: a?.permalink ?? null,
        postedAt: iso(rootTs),
        classification: a?.classification ?? null,
        affectedSystem: a?.affectedSystem ?? null,
        severity: a?.severity ?? null,
        customerImpact: a?.customerImpact ?? null,
        suspectedRootCause: a?.suspectedRootCause ?? null,
        resolutionStatus: a?.resolutionStatus ?? null,
        resolutionSummary: a?.resolutionSummary ?? null,
        normalizedWorkflowStatement: a?.normalizedWorkflowStatement ?? null,
        workflowClassification: a?.workflowClassification ?? null,
        automationStatus: a?.automationStatus ?? null,
      };
    });
    // Name: the most common proposed name across the group's own SAME edges.
    const names: string[] = [];
    for (let i = 0; i < g.members.length; i += 1) {
      for (let j = i + 1; j < g.members.length; j += 1) {
        const n = nameByPair.get([g.members[i], g.members[j]].sort().join("::"));
        if (n) names.push(n);
      }
    }
    const tally = new Map<string, number>();
    for (const n of names) tally.set(n, (tally.get(n) ?? 0) + 1);
    const name =
      [...tally.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
    const dates = g.members.map(iso).filter((v): v is string => v !== null).sort();

    return {
      groupId: groupId(g.members),
      name,
      alternateNames: [...new Set(names)].filter((n) => n !== name).sort(),
      members,
      occurrenceCount: members.length,
      firstSeen: dates[0] ?? null,
      lastSeen: dates.at(-1) ?? null,
      averageSameEdgeConfidence: g.averageConfidence,
      minimumSameEdgeConfidence: g.averageConfidence,
      averageSameEdgeSimilarity: 0,
      minimumSameEdgeSimilarity: 0,
      consistency: "fully_confirmed",
      splitFromConflictedComponent: false,
      sameEdges: [],
      relatedEdgesInsideGroup: [],
      differentEdgesInsideGroup: [],
      unadjudicatedPairsInsideGroup: [],
    } as RecurringIssueGroup;
  });

  techGroups.sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.groupId.localeCompare(b.groupId));

  const groupOutput: GroupOutput = {
    metadata: {
      ...adjudication.metadata,
      adjudicationInputFile: String(values.adjudications),
      extractionInputFile: String(values.extractions),
      createdAt: new Date().toISOString(),
      adjudicationModel: adjudication.metadata.model,
      adjudicationPromptVersion: adjudication.metadata.promptVersion,
      candidateSimilarityFloor: adjudication.metadata.candidateSimilarityFloor,
      adjudicatedPairs: adjudication.results.filter((r) => r.status === "success").length,
      sameEdges: techSame.length,
      relatedEdges: adjudication.results.filter((r) => r.relationship === "related_problem_family").length,
      differentEdges: techDifferent.length,
      candidateComponents: techCover.maximalCliquesConsidered,
      recurringGroups: techGroups.length,
      conflictedComponents: 0,
      overlappingGroups: 0,
      overlappingMembers: [],
      relatedPairCount: adjudication.results.filter((r) => r.relationship === "related_problem_family").length,
      groupingAlgorithm: "greedy_disjoint_maximal_clique_cover_complete_link",
    } as GroupOutput["metadata"],
    groups: techGroups,
  };

  const groupsPath = path.join(DIR, `groups-${windowTag}-v2-${date}.json`);
  await fs.writeFile(groupsPath, `${JSON.stringify(groupOutput, null, 2)}\n`, "utf8");

  const asOf = new Date();
  const report = buildRecurringIssueReport(groupOutput, asOf);
  const reportOutput: ReportOutput = {
    metadata: {
      groupsInputFile: path.relative(process.cwd(), groupsPath),
      createdAt: asOf.toISOString(),
      asOf: asOf.toISOString(),
      sourceWindowDays: adjudication.metadata.sourceWindowDays,
      adjudicationModel: adjudication.metadata.model,
      adjudicationPromptVersion: adjudication.metadata.promptVersion,
      candidateSimilarityFloor: adjudication.metadata.candidateSimilarityFloor,
    },
    report,
  };
  const reportPath = path.join(DIR, `report-${windowTag}-v2-${date}.json`);
  await writeReportOutput(reportOutput, reportPath);

  // ---------- PART B: workflow ----------
  const wfSame: SamePair[] = [];
  const wfDifferent: Array<{ a: string; b: string }> = [];
  for (const r of workflowAdjudication.results) {
    if (r.status !== "success") continue;
    if (r.relationship === "same_underlying_workflow") {
      wfSame.push({ a: r.a.rootTs, b: r.b.rootTs, confidence: r.confidence ?? 0 });
    } else if (r.relationship === "different") {
      wfDifferent.push({ a: r.a.rootTs, b: r.b.rootTs });
    }
  }

  const wfCover = buildDisjointCliqueCover(wfSame);
  try {
    assertDisjointIntegrity(wfCover.groups, wfSame, wfDifferent);
  } catch (err) {
    if (err instanceof DisjointGroupIntegrityError) fail(`✗ ${err.message}`);
    throw err;
  }

  const candidates = selectWorkflowEmbeddingCandidates(extraction);
  const byRootTs = new Map(candidates.map((c) => [c.rootTs, c]));
  const grouped = new Set(wfCover.groups.flatMap((g) => g.members));
  // Every candidate not in a multi-member clique becomes its own singleton, so
  // all 314 appear exactly once.
  const allGroups = [
    ...wfCover.groups.map((g) => g.members),
    ...candidates.filter((c) => !grouped.has(c.rootTs)).map((c) => [c.rootTs]),
  ];

  const wfClusters: WorkflowCluster[] = allGroups.map((memberIds) => {
    const members = memberIds.map((id) => byRootTs.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
    const classCounts = new Map<string, number>();
    for (const m of members) {
      if (m.workflowClassification) classCounts.set(m.workflowClassification, (classCounts.get(m.workflowClassification) ?? 0) + 1);
    }
    const statusBreakdown: Record<string, number> = {};
    for (const m of members) statusBreakdown[m.automationStatus] = (statusBreakdown[m.automationStatus] ?? 0) + 1;
    const degree = new Map<string, number>();
    for (const p of wfSame) {
      if (memberIds.includes(p.a) && memberIds.includes(p.b)) {
        degree.set(p.a, (degree.get(p.a) ?? 0) + 1);
        degree.set(p.b, (degree.get(p.b) ?? 0) + 1);
      }
    }
    const rep = [...members].sort(
      (a, b) => (degree.get(b.rootTs) ?? 0) - (degree.get(a.rootTs) ?? 0) || a.rootTs.localeCompare(b.rootTs),
    )[0];
    const dates = memberIds.map(iso).filter((v): v is string => v !== null).sort();
    const sorted = [...memberIds].sort();

    return {
      clusterId: `wf-v2-${sorted[0] as string}`,
      occurrenceCount: members.length,
      memberRootTs: sorted,
      workflowClassifications: [...classCounts.keys()].sort(),
      dominantWorkflowClassification:
        [...classCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
      automationStatusBreakdown: statusBreakdown,
      technicalWorkflowCount: members.filter((m) => m.nature === "technical+workflow").length,
      workflowOnlyCount: members.filter((m) => m.nature === "workflow-only").length,
      firstSeen: dates[0] ?? null,
      lastSeen: dates.at(-1) ?? null,
      representativeWorkflowStatement: rep?.statement ?? "",
      representativeRootTs: rep?.rootTs ?? (sorted[0] as string),
      samplePermalinks: members.map((m) => m.permalink).filter((l): l is string => l !== null).slice(0, 5),
      relatedClusterIds: [],
      internalSameEdgeCount: (members.length * (members.length - 1)) / 2,
    };
  });

  wfClusters.sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.clusterId.localeCompare(b.clusterId));

  const seen = new Set<string>();
  for (const c of wfClusters) {
    for (const m of c.memberRootTs) {
      if (seen.has(m)) fail(`✗ workflow member ${m} appears in more than one cluster`);
      seen.add(m);
    }
  }
  if (seen.size !== candidates.length) {
    fail(`✗ expected ${candidates.length} workflow members, got ${seen.size}`);
  }

  const wfOutput: WorkflowClusterOutput = {
    metadata: {
      extractionsInputFile: String(values.extractions),
      adjudicationsInputFile: String(values["workflow-adjudications"]),
      generatedAt: new Date().toISOString(),
      sourceWindowDays: workflowAdjudication.metadata.sourceWindowDays,
      clusteringAlgorithm: "greedy_disjoint_maximal_clique_cover_complete_link",
      clusterIdScheme: "wf-v2-<lexicographically-smallest-member-rootTs>",
      totalWorkflowCandidates: candidates.length,
      totalClusters: wfClusters.length,
      recurringClusters: wfClusters.filter((c) => c.occurrenceCount > 1).length,
      singletonClusters: wfClusters.filter((c) => c.occurrenceCount === 1).length,
      largestClusterSize: wfClusters[0]?.occurrenceCount ?? 0,
      sameEdges: wfSame.length,
      relatedEdges: workflowAdjudication.results.filter((r) => r.relationship === "related_workflow_family").length,
      differentEdges: wfDifferent.length,
      danglingSameEdges: 0,
      adjudicationModel: workflowAdjudication.metadata.model,
      adjudicationPromptVersion: workflowAdjudication.metadata.promptVersion,
      category: "workflow",
    },
    clusters: wfClusters,
  };
  const wfPath = path.join(DIR, `workflow-clusters-${windowTag}-v2-${date}.json`);
  await fs.writeFile(wfPath, `${JSON.stringify(wfOutput, null, 2)}\n`, "utf8");

  console.log("Regrouping v2 — complete-link disjoint clique cover");
  console.log("");
  console.log("TECHNICAL");
  console.log(`  maximal cliques considered: ${techCover.maximalCliquesConsidered}`);
  console.log(`  groups: ${techGroups.length} | members: ${techGroups.reduce((n, g) => n + g.occurrenceCount, 0)}`);
  console.log(`  largest: ${techGroups[0]?.occurrenceCount ?? 0} | overlapping: 0 | unassigned nodes: ${techCover.unassigned.length}`);
  console.log(`  → ${path.relative(process.cwd(), groupsPath)}`);
  console.log(`  → ${path.relative(process.cwd(), reportPath)}`);
  console.log("");
  console.log("WORKFLOW");
  console.log(`  clusters: ${wfClusters.length} | recurring: ${wfOutput.metadata.recurringClusters} | singletons: ${wfOutput.metadata.singletonClusters}`);
  console.log(`  largest: ${wfOutput.metadata.largestClusterSize} | all ${seen.size} candidates present exactly once`);
  console.log(`  → ${path.relative(process.cwd(), wfPath)}`);
  console.log("");
  console.log("No API calls were made. Nothing was posted to Slack.");
}

main().catch((err: unknown) => fail(`✗ ${err instanceof Error ? err.message : String(err)}`));
