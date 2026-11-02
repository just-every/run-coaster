/** Installation protection, shared by the production door and its public docs. */
export const agentCapacity = Object.freeze({ requestsPerMinute: 600, maxBodyBytes: 1_048_576 });
