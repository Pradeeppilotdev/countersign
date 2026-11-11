// Shared labels keep the page and each saved answer explicit about their source.
export function askSourceLabels(source) {
  const agent = source.agentVault ?? "not initialized or unavailable";
  const payment = source.paymentVault ?? "unavailable";
  const question = "Local agent vault · " + agent;
  const detail = source.separate
    ? "The Payments view uses a separate local vault: " + payment + ". Questions here read the agent vault and its inbox."
    : "The agent and Payments view use the same saved vault. Questions also read the agent inbox.";
  const account = source.accountNetwork === "local"
    ? "Local agent chain · " + agent
    : source.accountNetwork === "testnet" || source.accountNetwork === "mainnet"
      ? source.accountNetwork + " account lookup · FastNEAR + NearBlocks (read-only)"
      : "Account lookup network unavailable";
  return { question, detail, account };
}
