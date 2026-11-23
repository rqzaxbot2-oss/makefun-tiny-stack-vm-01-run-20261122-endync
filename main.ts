import * as fs from "node:fs";
import * as path from "node:path";

const OUT = process.env.MAKEFUN_OUTPUT_DIR || ".";
const ROOT = process.env.MAKEFUN_INPUT_DIR || process.cwd();

const STEP_LIMIT = 1_000_000;
const OUT_LIMIT = 1 << 20;
const STACK_LIMIT = 256;
const CALL_LIMIT = 256;
const MEM_SIZE = 256;

// Trap codes (exit codes). Halt is exit 0.
const TRAP = {
  STACK_OVERFLOW: 1,
  STACK_UNDERFLOW: 2,
  STEP_LIMIT: 3,
  BAD_INSTRUCTION: 4,
  DIV_BY_ZERO: 5,
  DIV_OVERFLOW: 6,
  CALL_OVERFLOW: 7,
  BAD_RETURN: 8,
  BAD_ADDRESS: 9,
  INPUT_EXHAUSTED: 10,
  OUTPUT_LIMIT: 11,
  UNKNOWN_OPCODE: 12,
} as const;

class Halt {
  constructor(public readonly exit: number) {}
}

function trap(code: number): never {
  throw new Halt(code);
}

function run(program: Buffer, input: Buffer): { out: Buffer; exit: number } {
  const out: number[] = [];
  const stack: number[] = [];
  const mem = new Int32Array(MEM_SIZE);
  const callStack: number[] = [];
  let ip = 0;
  let inPos = 0;
  let steps = 0;

  const push = (v: number): void => {
    if (stack.length >= STACK_LIMIT) trap(TRAP.STACK_OVERFLOW);
    stack.push(v | 0);
  };
  const pop = (): number => {
    if (stack.length === 0) trap(TRAP.STACK_UNDERFLOW);
    return stack.pop()!;
  };
  const need = (n: number): void => {
    if (ip + n > program.length) trap(TRAP.BAD_INSTRUCTION);
  };
  const readI16 = (): number => {
    need(2);
    const v = program.readInt16LE(ip);
    ip += 2;
    return v;
  };
  const readI32 = (): number => {
    need(4);
    const v = program.readInt32LE(ip);
    ip += 4;
    return v;
  };

  try {
    while (ip < program.length) {
      if (++steps > STEP_LIMIT) trap(TRAP.STEP_LIMIT);
      const op = program[ip++];
      switch (op) {
        case 0x00: // nop
          break;
        case 0x01: // push imm32
          push(readI32());
          break;
        case 0x02: { // push8
          need(1);
          push(program[ip++]);
          break;
        }
        case 0x03: { // dup
          const v = pop();
          push(v);
          push(v);
          break;
        }
        case 0x04: // drop
          pop();
          break;
        case 0x05: { // swap
          const a = pop();
          const b = pop();
          push(a);
          push(b);
          break;
        }
        case 0x06: { // over
          const a = pop();
          const b = pop();
          push(b);
          push(a);
          push(b);
          break;
        }
        case 0x07: { // add
          const b = pop();
          const a = pop();
          push((a + b) | 0);
          break;
        }
        case 0x08: { // sub
          const b = pop();
          const a = pop();
          push((a - b) | 0);
          break;
        }
        case 0x09: { // mul
          const b = pop();
          const a = pop();
          push(Math.imul(a, b));
          break;
        }
        case 0x0a: { // div
          const b = pop();
          const a = pop();
          if (b === 0) trap(TRAP.DIV_BY_ZERO);
          if (a === -2147483648 && b === -1) trap(TRAP.DIV_OVERFLOW);
          push((a / b) | 0);
          break;
        }
        case 0x0b: { // mod
          const b = pop();
          const a = pop();
          if (b === 0) trap(TRAP.DIV_BY_ZERO);
          push((a % b) | 0);
          break;
        }
        case 0x0c: { // and
          const b = pop();
          const a = pop();
          push(a & b);
          break;
        }
        case 0x0d: { // or
          const b = pop();
          const a = pop();
          push(a | b);
          break;
        }
        case 0x0e: { // xor
          const b = pop();
          const a = pop();
          push(a ^ b);
          break;
        }
        case 0x0f: { // shl
          const b = pop();
          const a = pop();
          push((a << (b & 31)) | 0);
          break;
        }
        case 0x10: { // shr (logical)
          const b = pop();
          const a = pop();
          push((a >>> (b & 31)) | 0);
          break;
        }
        case 0x11: { // sar (arithmetic)
          const b = pop();
          const a = pop();
          push((a >> (b & 31)) | 0);
          break;
        }
        case 0x12: { // neg
          const a = pop();
          push((-a) | 0);
          break;
        }
        case 0x13: { // not
          const a = pop();
          push(~a);
          break;
        }
        case 0x14: { // eq
          const b = pop();
          const a = pop();
          push(a === b ? 1 : 0);
          break;
        }
        case 0x15: { // ne
          const b = pop();
          const a = pop();
          push(a !== b ? 1 : 0);
          break;
        }
        case 0x16: { // lt
          const b = pop();
          const a = pop();
          push(a < b ? 1 : 0);
          break;
        }
        case 0x17: { // le
          const b = pop();
          const a = pop();
          push(a <= b ? 1 : 0);
          break;
        }
        case 0x18: { // gt
          const b = pop();
          const a = pop();
          push(a > b ? 1 : 0);
          break;
        }
        case 0x19: { // ge
          const b = pop();
          const a = pop();
          push(a >= b ? 1 : 0);
          break;
        }
        case 0x1a: { // jmp rel16
          const off = readI16();
          ip += off;
          break;
        }
        case 0x1b: { // jz rel16
          const off = readI16();
          const v = pop();
          if (v === 0) ip += off;
          break;
        }
        case 0x1c: { // jnz rel16
          const off = readI16();
          const v = pop();
          if (v !== 0) ip += off;
          break;
        }
        case 0x1d: { // call rel16
          const off = readI16();
          if (callStack.length >= CALL_LIMIT) trap(TRAP.CALL_OVERFLOW);
          callStack.push(ip);
          ip += off;
          break;
        }
        case 0x1e: { // ret
          if (callStack.length === 0) trap(TRAP.BAD_RETURN);
          ip = callStack.pop()!;
          break;
        }
        case 0x1f: // halt
          throw new Halt(0);
        case 0x20: { // load
          const addr = pop();
          if (addr < 0 || addr >= MEM_SIZE) trap(TRAP.BAD_ADDRESS);
          push(mem[addr]);
          break;
        }
        case 0x21: { // store
          const addr = pop();
          const v = pop();
          if (addr < 0 || addr >= MEM_SIZE) trap(TRAP.BAD_ADDRESS);
          mem[addr] = v;
          break;
        }
        case 0x22: { // in
          if (inPos >= input.length) trap(TRAP.INPUT_EXHAUSTED);
          push(input[inPos++]);
          break;
        }
        case 0x23: { // out
          const v = pop();
          if (out.length >= OUT_LIMIT) trap(TRAP.OUTPUT_LIMIT);
          out.push(v & 0xff);
          break;
        }
        default:
          trap(TRAP.UNKNOWN_OPCODE);
      }
    }
    // Falling off the end of the program is a normal exit.
    return { out: Buffer.from(out), exit: 0 };
  } catch (e) {
    if (e instanceof Halt) {
      return { out: Buffer.from(out), exit: e.exit };
    }
    // Unexpected internal error: treat as unknown-opcode trap so we still
    // produce a well-formed answer rather than crashing the whole set.
    return { out: Buffer.from(out), exit: TRAP.UNKNOWN_OPCODE };
  }
}

function main(): void {
  fs.mkdirSync(OUT, { recursive: true });

  let entries: string[];
  try {
    entries = fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return;
  }

  for (const name of entries) {
    const dir = path.join(ROOT, name);
    const progPath = path.join(dir, "program.bin");
    const inPath = path.join(dir, "input.bin");

    let program: Buffer;
    try {
      program = fs.readFileSync(progPath);
    } catch {
      continue;
    }

    let input: Buffer;
    try {
      input = fs.readFileSync(inPath);
    } catch {
      input = Buffer.alloc(0);
    }

    const { out, exit } = run(program, input);

    const outDir = path.join(OUT, name);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "output.bin"), out);
    fs.writeFileSync(path.join(outDir, "exit.txt"), String(exit));
  }
}

main();