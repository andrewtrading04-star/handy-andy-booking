// api/_lib/apply-quiz.js
//
// The technician-applicant screening quiz (migration 0114). Indeed sends
// people to public/apply.html; they take this fixed quiz before they're
// allowed to create a tech account. Correct answers live ONLY here, never in
// anything served to the browser -- apply_start (api/tech.js) strips
// `correct` before sending questions out, and grading happens server-side in
// applySubmit.
//
// Fixed order, same question set for everyone (no randomized subset): the
// owner chose simplicity over anti-cheating resistance for v1. Short-answer
// questions are captured for a human to read later (Analytics tab) but never
// scored -- only the multiple-choice section decides pass/fail.

// _lib is not a route, so this file does not count against Vercel's function cap.

// The correct answer sits in a different position from question to question
// on purpose: with a fixed order (no shuffling), an all-first-choice key
// would let anyone pass by tapping the top option every time.
export const QUESTIONS = [
  { key: 'q1',  prompt: "What's the best tool for locating a wall stud before drilling?", choices: ['Knock and listen', 'A tape measure from the corner', 'A stud finder', 'Just eyeball it'], correct: 2 },
  { key: 'q2',  prompt: 'Standard stud spacing in most U.S. homes is:', choices: ['12 inches', '16 inches', '24 inches', "There's no standard"], correct: 1 },
  { key: 'q3',  prompt: "What tool makes sure the TV isn't crooked before final tightening?", choices: ['A stud finder', 'A tape measure', 'A drill bit gauge', 'A level'], correct: 3 },
  { key: 'q4',  prompt: "A customer's wall is drywall with no stud where they want the TV. What do you use?", choices: ['A regular plastic anchor', 'A toggle bolt or heavy-duty drywall anchor rated for the weight', 'Just screws into the drywall', 'Super glue'], correct: 1 },
  { key: 'q5',  prompt: 'Mounting into brick or stone, what fastener do you reach for?', choices: ['A drywall anchor', 'A wood screw drilled straight in', 'A nail gun', 'A concrete/masonry anchor (e.g. Tapcon)'], correct: 3 },
  { key: 'q6',  prompt: "Customer wants it mounted over a fireplace on stacked stone. What's your biggest concern before drilling?", choices: ['Just the color of the bracket', 'Whether the remote will reach', 'Depth/hollow spots behind the stone and heat exposure to the TV', 'Nothing, stone is easy'], correct: 2 },
  { key: 'q7',  prompt: "You find a stud but it's not exactly where the customer wants the TV centered. What do you do?", choices: ['Drill wherever they want and hope it holds', 'Explain the tradeoff, offset slightly or use a heavy anchor, get their OK', 'Refuse the job', "Tell them to move their furniture"], correct: 1 },
  { key: 'q8',  prompt: 'What does "VESA pattern" refer to?', choices: ['The brand of the mount', 'The size of the TV', 'The weight limit', 'The bolt-hole spacing on the back of the TV'], correct: 3 },
  { key: 'q9',  prompt: "Customer wants to watch TV from bed on a wall that's at an angle to the seating. What mount type do you recommend?", choices: ['A fixed mount', 'A tilt-only mount', 'A full-motion/articulating mount', 'Whatever is cheapest'], correct: 2 },
  { key: 'q10', prompt: "How do you find a TV's max weight and VESA size before the job?", choices: ["Check the TV's model number/manual or measure the mounting holes", 'Guess based on screen size', 'Ask the customer to guess', 'Weigh the whole box'], correct: 0 },
  { key: 'q11', prompt: 'Customer wants cables hidden inside the wall. What do you need to check first?', choices: ['Nothing, all walls are the same', "There's no insulation, blown-in fill, or fire blocking in the way, and no nearby electrical", 'Just start cutting', 'Ask them to buy a longer cable instead'], correct: 1 },
  { key: 'q12', prompt: 'What kind of cable is code-rated to run inside a wall cavity?', choices: ['Any HDMI cable from the store', 'An extension cord', "Doesn't matter", 'In-wall-rated / plenum or CL2/CL3 rated cable'], correct: 3 },
  { key: 'q13', prompt: 'You cut a hole for a low-voltage plate and hit something unexpected behind the drywall (looks like a pipe or wire). What do you do?', choices: ["Keep cutting, it's probably fine", "Patch it and don't mention it", 'Stop, inspect carefully, and adjust/relocate before continuing', "Call the customer's neighbor"], correct: 2 },
  { key: 'q14', prompt: 'Before drilling into any wall, what should you always check for?', choices: ['Nearby outlets/switches that indicate wiring behind the wall', 'The color of the wall', 'How many pictures are already up', 'Nothing, just drill'], correct: 0 },
  { key: 'q15', prompt: "What's a safe practice when working on a ladder in a customer's home?", choices: ['Lean it against the wall and climb fast', 'Stand on the top step', 'Balance on furniture instead', "Have it fully open and locked on stable, level ground, don't overreach"], correct: 3 },
  { key: 'q16', prompt: "You're running 15 minutes late to an appointment. What's the right move?", choices: ["Show up late and don't mention it", 'Call or text the customer as soon as you know, before the appointment time', 'Cancel without telling them', 'Have the next customer wait instead'], correct: 1 },
  { key: 'q17', prompt: 'While drilling, you accidentally chip a small piece of paint/drywall. What do you do?', choices: ['Patch it quietly and say nothing', 'Blame it on the wall being old', 'Tell the customer right away and let the office know', 'Leave a note in the mailbox'], correct: 2 },
  { key: 'q18', prompt: 'A customer asks you to do something outside the scope of the original job mid-visit. What do you do?', choices: ['Just do it for free to be nice', 'Refuse and leave immediately', 'Do it and add a random charge yourself', "Let them know it's extra and get pricing confirmed with the office before doing it"], correct: 3 },
  { key: 'q19', prompt: 'After mounting, the TV looks slightly off-level once loaded with cables. What do you do before calling the job done?', choices: ['Re-check with a level and adjust before leaving', 'Leave it, cables will settle', "Tell the customer it's normal", 'Tighten it more, that always fixes it'], correct: 0 },
  { key: 'q20', prompt: "Customer's outlet is far from where the TV will hang and there's no electrician on the job. What do you tell them?", choices: ['Just drill through the wall to the outlet no matter what', 'Explain the options -- visible cord, cord cover, or an in-wall power kit if code allows -- before you start', "Tell them it's impossible", 'Plug it in somewhere else in the house'], correct: 1 },
];

export const SHORT_ANSWER_QUESTIONS = [
  { key: 'q21', prompt: 'Tell us about a time you had to fix a mistake on a job (yours or someone else’s). What did you do?' },
  { key: 'q22', prompt: 'A customer’s wall doesn’t have a stud where they want the TV, and doing it right means a heavier-duty anchor kit that costs $40 more. In your own words, how would you explain that to the customer?' },
];

// 16 of 20 (80%) on the graded multiple-choice section. Short answers never
// count toward this -- they're read by a human, not scored.
export const PASS_THRESHOLD = 16;

// Same-day retake block, checked against the applicant's phone number.
export const RETAKE_COOLDOWN_HOURS = 24;

// Who a pass gets invited as. Hardcoded rather than data-driven: only one
// metro is ever "currently hiring" at a time (public/apply.html's badge), and
// changing it is a one-line edit here plus the badge on the page -- both
// already flagged as a single change when the owner opens a new city.
export const HIRING = {
  businessId: '2d93ffe1-015e-4122-8967-315dc77d9802',   // Handy Andy
  serviceAreaId: 'fd8d3119-8dde-43c3-b0ab-24839569a09a', // Los Angeles
  metro: 'Los Angeles',
};

// What apply.html actually fetches: no `correct` field, so the answer key
// never reaches the browser.
export function publicQuestions() {
  return {
    multiple_choice: QUESTIONS.map(q => ({ key: q.key, prompt: q.prompt, choices: q.choices })),
    short_answer: SHORT_ANSWER_QUESTIONS.map(q => ({ key: q.key, prompt: q.prompt })),
  };
}

// answers: [{ key, choice }] -- choice is the index the applicant picked.
// Unknown keys and out-of-range choices just score as wrong, never throw, so
// a stale client can't 500 the endpoint.
export function gradeAnswers(answers) {
  const byKey = new Map((Array.isArray(answers) ? answers : []).map(a => [a?.key, a?.choice]));
  const graded = QUESTIONS.map(q => {
    const choice = byKey.get(q.key);
    const correct = Number.isInteger(choice) && choice === q.correct;
    return { key: q.key, choice: Number.isInteger(choice) ? choice : null, correct };
  });
  const score = graded.filter(g => g.correct).length;
  return { graded, score, total: QUESTIONS.length, passed: score >= PASS_THRESHOLD };
}
