import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error("Sofa crashed:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot">
          <div className="landing-card">
            <div className="logo">Sofa</div>
            <p className="tagline" style={{ margin: "8px 0 20px" }}>
              Something went wrong. A reload usually fixes it.
            </p>
            <button className="btn primary wide" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
