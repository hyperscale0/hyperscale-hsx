# Examples

Each standard-library module has its own directory with an HSX program, a
short lesson, and pinned canonical UDL bytes. The test suite reads the module
list from `std/settlements`, compiles every program, and compares each emitted
document byte for byte.

The numbered examples remain as longer lessons. They cover a first program,
imports, diagnostic repair, a composed product, and a multi-instrument club.

Run an example with the installed CLI:

```sh
hsx check examples/instant_transfer/instant_transfer.hsx
hsx build examples/instant_transfer/instant_transfer.hsx --out program.udl
```

Every company and person in these files is invented.
