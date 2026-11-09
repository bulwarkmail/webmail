// A text checker for integration/tests/23-proofreading.spec.ts: answers from
// two fixed rules, in the plugin frame, so the spec tests the host's side
// (underlines, popup, list, keyboard, plain text, policy) without a server.

var RULES = [
  { find: /\bdem( Brief)\b/g, length: 3, kind: 'grammar', message: 'Use the accusative here: "den Brief".', shortMessage: 'Case', replacements: ['den'], ruleId: 'DEM_DEN', ruleLabel: 'dem/den' },
  { find: /\bteh\b/g, length: 3, kind: 'spelling', message: 'Possible spelling mistake.', replacements: ['the', 'ten'], ruleId: 'TYPO', ruleLabel: 'Typos' },
];

function check(request) {
  var out = [];
  request.segments.forEach(function (segment) {
    RULES.forEach(function (rule) {
      rule.find.lastIndex = 0;
      var m;
      while ((m = rule.find.exec(segment.text))) {
        out.push({
          segmentId: segment.id, offset: m.index, length: rule.length, kind: rule.kind,
          message: rule.message, shortMessage: rule.shortMessage, replacements: rule.replacements,
          ruleId: rule.ruleId, ruleLabel: rule.ruleLabel,
        });
      }
    });
  });
  return out;
}

exports.activate = function (api) {
  return api.composer.registerChecker({
    id: 'mock',
    label: 'Test checker',
    kinds: ['spelling', 'grammar'],
    debounceMs: 300,
    warnBeforeSend: true,
    check: check,
    onAction: function () {},
  });
};
