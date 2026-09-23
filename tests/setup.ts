import { valueFreeze } from "@/core/doc/freeze";

// Every suite runs with the document's values frozen: a command that writes
// into a track, a key or a transform an undo step still holds throws here.
valueFreeze.enabled = true;
