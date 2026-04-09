#include "prismical_aec3.h"

// Intentionally empty.
//
// This target normally compiles the local stub bridge implementation. When a
// vendored WebRTC bundle is present, Package.swift excludes that stub source
// file and links the prebuilt static library instead. Keeping a translation
// unit here allows the module to remain valid in both modes.
