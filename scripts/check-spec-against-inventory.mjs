// Checks a Markdown spec against the operation inventory produced by extract-x-operations.mjs:
// every queryId the spec pairs with an operation must match the bundle, and every feature switch
// or field toggle it attributes to an operation must exist in that operation's metadata.
// Usage: node scripts/check-spec-against-inventory.mjs spec.md x-operations.json
import fs from 'node:fs';

const [specPath, inventoryPath] = process.argv.slice(2);
const spec = fs.readFileSync(specPath, 'utf8');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const byName = new Map(inventory.operations.map(o => [o.operationName, o]));
const byQueryId = new Map(inventory.operations.map(o => [o.queryId, o]));
const allFeatures = new Set(inventory.operations.flatMap(o => [...(o.featureSwitches || []), ...(o.fieldToggles || [])]));

const findings = [];
const lines = spec.split('\n');
const opPattern = new RegExp(`\\b(${[...byName.keys()].sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');

lines.forEach((line, index) => {
  const ops = [...line.matchAll(opPattern)].map(m => m[1]);
  const ids = [...line.matchAll(/(?<![\w-])([A-Za-z0-9_-]{22})(?![\w-])/g)].map(m => m[1]).filter(id => /[A-Z]/.test(id) && /[a-z]/.test(id));
  for (const id of ids) {
    const owner = byQueryId.get(id);
    if (!owner) findings.push({ line: index + 1, kind: 'unknown-queryId', id, text: line.trim().slice(0, 200) });
    else if (ops.length && !ops.includes(owner.operationName)) findings.push({ line: index + 1, kind: 'queryId-on-wrong-op', id, belongsTo: owner.operationName, opsOnLine: ops, text: line.trim().slice(0, 200) });
  }
  for (const op of ops) {
    const def = byName.get(op);
    const typeWord = line.match(/\b(query|mutation)\b/i)?.[1]?.toLowerCase();
    if (typeWord && ops.length === 1 && typeWord !== def.operationType) findings.push({ line: index + 1, kind: 'type-mismatch', op, spec: typeWord, bundle: def.operationType });
  }
});

// Feature names: any snake_case identifier that looks like a feature switch but is not in the bundle.
const featureLike = [...new Set([...spec.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+){2,})\b/g)].map(m => m[1]))];
const unknownFeatures = featureLike.filter(f => /enabled|fetch|_api_|graphql|grok|rweb|responsive_web|longform|tweet|view_counts|freedom|standardized/.test(f) && !allFeatures.has(f));

// Operations the spec names that the bundle defines, and the important ones it never mentions.
const mentioned = new Set([...spec.matchAll(opPattern)].map(m => m[1]));
const needed = ['DeleteTweet', 'DeleteRetweet', 'UnfavoriteTweet', 'UserTweets', 'UserTweetsAndReplies', 'Likes', 'Following', 'Followers', 'BlueVerifiedFollowers'];
const result = {
  spec: specPath,
  inventory: inventoryPath,
  operationsMentioned: [...mentioned].sort(),
  neededButNotMentioned: needed.filter(n => !mentioned.has(n)),
  findings,
  unknownFeatureNames: unknownFeatures
};
console.log(JSON.stringify(result, null, 2));
