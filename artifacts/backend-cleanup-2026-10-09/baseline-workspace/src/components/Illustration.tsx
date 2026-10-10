import type { CategoryId } from "../data";
export function Illustration({ type }: { type: CategoryId }) {
  return (
    <svg
      viewBox="0 0 260 144"
      fill="none"
      aria-hidden="true"
      className="illustration"
    >
      <defs>
        <pattern
          id={`dots-${type}`}
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".65" fill="currentColor" opacity=".16" />
        </pattern>
      </defs>
      <rect width="260" height="144" fill={`url(#dots-${type})`} />
      <ellipse
        cx="132"
        cy="121"
        rx="65"
        ry="8"
        fill="currentColor"
        opacity=".045"
      />
      <g
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {type === "invention" && (
          <>
            <circle
              cx="129"
              cy="64"
              r="45"
              strokeDasharray="3 5"
              opacity=".22"
            />
            <path
              d="M112 85c0-13-15-15-15-35a32 32 0 0 1 64 0c0 20-15 22-15 35"
              fill="white"
            />
            <path d="M112 85h34v9h-34zM115 98h28M118 104h22M123 111h12" />
            <path
              d="M123 85V64l-10-13 9 4 7-12 7 12 9-4-10 13v21"
              opacity=".65"
            />
            <path d="M129 6v-5M85 19l-6-6M69 52h-8M176 19l6-6M189 52h8" />
            <path d="M77 84h-9v22h29M175 91h19V73h12" opacity=".45" />
            <circle cx="98" cy="106" r="3" fill="white" />
            <circle cx="208" cy="73" r="3" fill="white" />
            <path d="M185 108h9m-4.5-4.5v9M59 28h7m-3.5-3.5v7" opacity=".5" />
          </>
        )}
        {type === "utility" && (
          <>
            <path d="m129 20 49 26-49 26-49-26 49-26Z" fill="white" />
            <path d="M80 46v24l49 27 49-27V46M129 72v25" />
            <path
              d="m80 83 49 27 49-27M80 95l49 27 49-27M80 83v12M178 83v12M129 110v12"
              opacity=".6"
            />
            <path
              d="m112 40 18-10 19 10-19 10-18-10ZM112 40v11l18 10 19-10V40M130 50v11"
              fill="white"
            />
            <path
              d="M66 30v75M62 30h8M62 105h8M192 42v64M188 42h8M188 106h8"
              strokeDasharray="2 4"
              opacity=".4"
            />
            <circle cx="205" cy="23" r="12" opacity=".4" />
            <path d="M201 23h8M205 19v8M52 66h7m-3.5-3.5v7" opacity=".6" />
          </>
        )}
        {type === "design" && (
          <>
            <path d="M88 30h84v80H88z" strokeDasharray="3 4" opacity=".28" />
            <path
              d="M83 24h10M88 19v10M167 24h10M172 19v10M83 116h10M88 111v10M167 116h10M172 111v10"
              opacity=".5"
            />
            <path
              d="M107 52c0-16 46-16 46 0v45c0 18-46 18-46 0V52Z"
              fill="white"
            />
            <ellipse cx="130" cy="52" rx="23" ry="12" />
            <ellipse cx="130" cy="51" rx="13" ry="6" opacity=".45" />
            <path
              d="M114 75c9 7 24 7 32 0M114 84c9 7 24 7 32 0M114 93c9 7 24 7 32 0"
              opacity=".32"
            />
            <path
              d="m187 44 7-7 8 8-7 7-8-8Zm0 0-17 17-3 11 11-3 17-17M170 61l8 8"
              fill="white"
            />
            <path d="M61 73h13M67.5 66.5v13M186 98h8m-4-4v8" opacity=".5" />
          </>
        )}
        {type === "software" && (
          <>
            <rect x="73" y="26" width="120" height="81" rx="6" fill="white" />
            <path d="M73 43h120" />
            <circle cx="82" cy="35" r="1" />
            <circle cx="89" cy="35" r="1" />
            <circle cx="96" cy="35" r="1" />
            <path d="m111 61-12 12 12 12m40-24 12 12-12 12m-15-27-10 31M114 107l-5 12h45l-5-12" />
            <rect x="176" y="84" width="30" height="35" rx="5" fill="white" />
            <path d="M184 84v-5a7 7 0 0 1 14 0v5M191 99v7" />
            <circle cx="191" cy="97" r="2" />
            <path
              d="M60 55H48v31h12M54 105h8m-4-4v8M208 48h8m-4-4v8"
              opacity=".45"
            />
          </>
        )}
      </g>
    </svg>
  );
}
