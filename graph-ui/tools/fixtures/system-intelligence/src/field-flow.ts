/** A deliberately small static field-flow fixture, with no external runtime. */
export function readEmail(input: { email: string; name: string }) {
  const email = input.email;
  const other = input.name;
  return email;
}

export function decorate(input: string) {
  const output = input + '@example.test';
  return output;
}

export function repeat(input: string) {
  let output = input;
  output = output + '!';
  return output;
}

/** Literal operands establish a primitive operation without trusting a parameter annotation. */
export function primitiveTransform() {
  const input = 41;
  const output = input + 1;
  return output;
}
