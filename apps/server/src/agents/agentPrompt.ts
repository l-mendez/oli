/** Newest memories kept in the prompt; older ones stay stored but are left out. */
const MAX_PROMPT_MEMORIES = 100;

export interface AgentPromptInput {
  readonly name: string;
  readonly role: string;
  readonly context: ReadonlyArray<{ readonly path: string }>;
  /** Oldest first. */
  readonly memory: ReadonlyArray<string>;
  readonly trigger: { readonly label: string; readonly instruction: string };
}

// Webhook tasks fill {{...}} from the request. Only the trigger instruction may
// carry placeholders, so text an agent remembered can never pull payload fields.
const literal = (text: string) => text.replaceAll("{{", "{ {").replaceAll("}}", "} }");

const bullets = (items: ReadonlyArray<string>) => items.map((item) => `- ${item}`).join("\n");

/**
 * The full prompt a run starts with. Role, context and memory are always
 * present, so the provider never decides whether to load them.
 */
export function composeAgentPrompt(input: AgentPromptInput): string {
  const memory = input.memory.slice(-MAX_PROMPT_MEMORIES);
  const sections = [
    `You are "${literal(input.name)}", a long-lived agent. You were woken by: ${literal(input.trigger.label)}.`,
    `## Your role\n${literal(input.role)}`,
    input.context.length === 0
      ? null
      : `## Read first\nRead each of these files in full before you do anything else:\n${bullets(
          input.context.map((file) => literal(file.path)),
        )}`,
    memory.length === 0
      ? null
      : `## What you remember from earlier runs\n${bullets(memory.map(literal))}`,
    `## This run\n${input.trigger.instruction}`,
  ];
  return sections.filter((section) => section !== null).join("\n\n");
}
