import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { Anchor, Badge, Button, Group, Stack, Text } from "@mantine/core";
import type {
  ConsoleCallPage,
  ConsoleCallSummary,
} from "../../../packages/contracts/src/console";
import type { ConsoleConversation } from "../../../packages/contracts/src/console-configuration";
import { api, useResource } from "./api";
import {
  date,
  Empty,
  Failure,
  label,
  Loading,
  PageTitle,
  Panel,
  seconds,
  Status,
} from "./shared";

// Every call's conversation on one page, refreshed every 10 seconds.
// A call whose conversation fails to load is still listed, with the error shown.

const conversationPath = (id: string) =>
  `/calls/${encodeURIComponent(id)}/conversation`;

const availabilityText: Record<string, string> = {
  disabled: "Conversation capture was turned off for this call.",
  expired: "Conversation text for this call has expired.",
  empty: "No conversation was recorded for this call.",
};

type Loaded = {
  call: ConsoleCallSummary;
  conversation: ConsoleConversation | undefined;
  error: Error | null;
  pending: boolean;
};

export function Transcripts() {
  const [limit, setLimit] = useState(25);
  const calls = useResource<ConsoleCallPage>(`/calls?limit=${limit}`);
  const items = calls.data?.items ?? [];
  const conversations = useQueries({
    queries: items.map((item) => {
      const path = conversationPath(item?.call?.call_id ?? "");
      return {
        queryKey: [path],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api<ConsoleConversation>(path, { signal }),
        refetchInterval: () =>
          document.visibilityState === "visible" ? 10_000 : (false as const),
        refetchIntervalInBackground: false,
      };
    }),
  });
  const loaded: Loaded[] = items.map((call, index) => ({
    call,
    conversation: conversations[index]?.data,
    error: (conversations[index]?.error as Error | null) ?? null,
    pending: conversations[index]?.isPending ?? true,
  }));
  const total = calls.data?.total ?? 0;
  return (
    <>
      <PageTitle
        title="Call scripts"
        description="Every call's conversation, newest first. Updates every 10 seconds."
        action={
          <Button
            variant="default"
            disabled={!loaded.length}
            onClick={() => downloadAll(loaded)}
          >
            Download all
          </Button>
        }
      />
      {calls.isPending ? (
        <Loading />
      ) : calls.error ? (
        <Failure error={calls.error} retry={() => void calls.refetch()} />
      ) : !loaded.length ? (
        <Empty title="No calls yet" text="Call conversations appear here." />
      ) : (
        <Stack gap="lg">
          {loaded.map((entry, index) => (
            <CallScript
              key={entry.call?.call?.call_id ?? index}
              entry={entry}
            />
          ))}
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              Showing {loaded.length} of {total.toLocaleString()} calls
            </Text>
            {limit < 100 && total > loaded.length && (
              <Button
                variant="default"
                onClick={() => setLimit((v) => Math.min(100, v + 25))}
              >
                Show more
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </>
  );
}

function CallScript({ entry }: { entry: Loaded }) {
  const { call, conversation, error, pending } = entry;
  const id = call?.call?.call_id ?? "";
  const turns = conversation?.turns ?? [];
  return (
    <Panel
      title={`${call?.call?.target_id ?? "Unknown target"} · ${
        call?.call?.created_at ? date(call.call.created_at) : "Unknown time"
      }`}
      aside={
        <Group gap={8}>
          <Text size="xs" c="dimmed">
            {label(call?.call?.direction ?? "unknown")} ·{" "}
            {seconds(call?.duration_seconds ?? null)}
          </Text>
          <Status value={call?.call?.state ?? "unknown"} />
          {id && (
            <Anchor component={Link} to={`/calls/${encodeURIComponent(id)}`} size="sm">
              Details
            </Anchor>
          )}
        </Group>
      }
    >
      {pending ? (
        <Loading />
      ) : error ? (
        <Failure error={error} />
      ) : !turns.length ? (
        <Text size="sm" c="dimmed">
          {availabilityText[conversation?.availability ?? "empty"] ??
            availabilityText.empty}
        </Text>
      ) : (
        <Stack gap="sm">
          {turns.map((turn, index) => (
            <div
              className={`fragment ${turn?.speaker ?? ""}`}
              key={turn?.id ?? index}
            >
              <Group justify="space-between">
                <Text size="sm" fw={600}>
                  {speakerName(turn?.speaker)}
                </Text>
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    {seconds(
                      typeof turn?.start_ms === "number"
                        ? turn.start_ms / 1000
                        : null,
                    )}
                  </Text>
                  {turn?.final === false && (
                    <Badge variant="light" color="orange" size="xs">
                      Partial
                    </Badge>
                  )}
                </Group>
              </Group>
              <Text size="sm" mt={6} className="preserve-text">
                {turn?.text ?? ""}
              </Text>
            </div>
          ))}
        </Stack>
      )}
    </Panel>
  );
}

const speakerName = (speaker: string | undefined) =>
  speaker === "user" ? "Customer" : speaker === "assistant" ? "Agent" : "Unknown";

function downloadAll(loaded: Loaded[]) {
  const lines: string[] = [
    `VoxDock call scripts — exported ${new Date().toLocaleString()}`,
    "",
  ];
  for (const { call, conversation, error } of loaded) {
    lines.push(
      "=".repeat(60),
      `Call: ${call?.call?.call_id ?? "unknown"}`,
      `Target: ${call?.call?.target_id ?? "unknown"}`,
      `Started: ${call?.call?.created_at ?? "unknown"}`,
      `Direction: ${call?.call?.direction ?? "unknown"}  State: ${call?.call?.state ?? "unknown"}  Length: ${seconds(call?.duration_seconds ?? null)}`,
      "",
    );
    const turns = conversation?.turns ?? [];
    if (error) lines.push("[Conversation could not be loaded]");
    else if (!turns.length)
      lines.push(
        `[${availabilityText[conversation?.availability ?? "empty"] ?? availabilityText.empty}]`,
      );
    for (const turn of turns)
      lines.push(
        `${speakerName(turn?.speaker)}${turn?.final === false ? " (partial)" : ""}: ${turn?.text ?? ""}`,
      );
    lines.push("");
  }
  const url = URL.createObjectURL(
    new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `voxdock-call-scripts-${new Date().toISOString().slice(0, 10)}.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
