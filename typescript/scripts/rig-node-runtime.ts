import process from "node:process";

// NUL separates the two fields without restricting spaces in executable paths.
process.stdout.write(
  `${process.execPath}\0${process.versions.node.split(".", 1)[0]}`
);
