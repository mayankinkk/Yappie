export function captionsEnabled(): boolean {
  return localStorage.getItem("yappie.captions") !== "off";
}

export function setCaptionsEnabled(on: boolean): void {
  localStorage.setItem("yappie.captions", on ? "on" : "off");
}
