export const shortText = (value, limit = 48) => {
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
};

export function buildPrompt(task, earlier, steps, budget) {
  const opening = [
    earlier.length ? 'Earlier in this session:\n' + earlier.map(item => `- Task: ${shortText(item.task, 200)}\n  Answer: ${shortText(item.answer, 400)}`).join('\n') + '\n' : '',
    'Task:\n' + task,
  ].join('\n');
  const rendered = steps.map((step, index) => {
    const outcome = Object.hasOwn(step, 'ownerInput')
      ? 'Owner input:\n' + JSON.stringify(step.ownerInput)
      : 'Result:\n' + step.observation;
    return 'Step ' + (index + 1) + ', your reply:\n' + step.reply + '\n\n' + outcome;
  });
  let kept = rendered.length;
  const closing = '\n\nReply with your next tool call.';
  const size = count => opening.length + closing.length + rendered.slice(rendered.length - count).join('\n\n').length + 64;
  while (kept > 1 && size(kept) > budget) kept -= 1;
  const omitted = rendered.length - kept;
  return [opening, omitted ? `[${omitted} earlier steps omitted to fit the context budget]` : '', ...rendered.slice(rendered.length - kept)]
    .filter(Boolean).join('\n\n') + closing;
}

