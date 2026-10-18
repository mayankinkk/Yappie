export function captionsEnabled(): boolean {
  return localStorage.getItem("sofa.captions") !== "off";
}

export function setCaptionsEnabled(on: boolean): void {
  localStorage.setItem("sofa.captions", on ? "on" : "off");
}
