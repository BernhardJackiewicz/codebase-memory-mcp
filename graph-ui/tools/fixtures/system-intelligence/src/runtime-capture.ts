export function decorate(input: string) {
    const output = input + "!";
    return output;
}

export function run(input: string) {
    const copied = input;
    const result = decorate(copied);
    return result;
}
