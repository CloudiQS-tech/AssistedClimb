import { eq } from "drizzle-orm";
import { db, restorationControlTable } from "@workspace/db";

export type RestorationAdmissionState = "ready" | "quarantined" | "reconciling" | "failed" | "unavailable";

export async function getRestorationAdmissionState(): Promise<RestorationAdmissionState> {
  try {
    const expectedFenceId = process.env.RESTORATION_FENCE_ID?.trim();
    const [control] = await db.select({
      state: restorationControlTable.state,
      releaseFenceId: restorationControlTable.releaseFenceId,
    })
      .from(restorationControlTable)
      .where(eq(restorationControlTable.id, 1));

    // RESTORATION_FENCE_ID is only meaningful once a restore-reconciliation run has
    // actually stamped a release fence onto the control row (see
    // lib/db/migrations/0028_deletion_tombstones_and_restore_reconciliation.sql,
    // which seeds state='ready' with release_fence_id=NULL by default). If no
    // reconciliation has ever run for this database, control.releaseFenceId is NULL
    // and there is nothing to fence against - treat that as "no restore in progress"
    // rather than quarantining every fresh deployment that hasn't set this var.
    // Only enforce the fence once the database itself has recorded one.
    if (expectedFenceId && control?.releaseFenceId && control.releaseFenceId !== expectedFenceId) {
      return "quarantined";
    }
    return control?.state ?? "unavailable";
  } catch {
    return "unavailable";
  }
}