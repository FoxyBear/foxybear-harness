/**
 * SDD-05 / Phase M-2 — SessionTurn type.
 *
 * The post-turn hook (W-7) builds a SessionTurn from the prompt loop state
 * and passes it to MemoryCapture.capture. TraceIngestor.ingest reads the
 * withParts[] array to emit ACTION/ERROR/MESSAGE nodes + COLLABORATION/
 * ERROR_CORRECTION/EVIDENCE hyperedges.
 */
import type { SessionID, MessageID } from "../../session/schema"
import type { MessageV2 } from "../../session/message-v2"

export interface SessionTurn {
  sessionID: SessionID
  messageID: MessageID
  withParts: MessageV2.WithParts[]
  persona: string
  project_id: string
}
