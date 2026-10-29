<script lang="ts">
  import logoBlack from "../../../assets/brand/nelcota-logo-black.svg";
  import logoWhite from "../../../assets/brand/nelcota-logo-white.svg";
  import symbolBlack from "../../../assets/brand/nelcota-symbol-black.svg";
  import symbolWhite from "../../../assets/brand/nelcota-symbol-white.svg";

  let {
    class: className = "",
    mark = false,
    size = "md",
    decorative = false,
  }: { class?: string; mark?: boolean; size?: "md" | "lg" | "xl"; decorative?: boolean } = $props();

  const DIMENSIONS = {
    mark: { md: "size-10", lg: "size-12", xl: "size-16" },
    wordmark: { md: "w-60 h-auto", lg: "w-72 h-auto", xl: "w-80 h-auto" },
  } as const;
  const dimensions = $derived((mark ? DIMENSIONS.mark : DIMENSIONS.wordmark)[size]);
</script>

<span class={["inline-flex shrink-0 items-center", mark ? "p-2.5" : "p-1", className]}>
  <img
    src={mark ? symbolBlack : logoBlack}
    alt={decorative ? "" : "Nelcota"}
    width={mark ? 594 : 2048}
    height={mark ? 542 : 768}
    class={["block select-none object-contain dark:hidden", dimensions]}
    draggable="false"
  />
  <img
    src={mark ? symbolWhite : logoWhite}
    alt={decorative ? "" : "Nelcota"}
    width={mark ? 594 : 2048}
    height={mark ? 542 : 768}
    class={["hidden select-none object-contain dark:block", dimensions]}
    draggable="false"
  />
</span>
