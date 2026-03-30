<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/branding/Bulwark%20Logo%20with%20Lettering%20White%20and%20Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="public/branding/Bulwark%20Logo%20with%20Lettering%20Dark%20Color.svg" />
  <img src="public/branding/Bulwark%20Logo%20with%20Lettering%20Dark%20Color.svg" alt="Bulwark Webmail" width="220" />
</picture>

</div>

# Contributing to Bulwark Webmail

Thank you for your interest in contributing to Bulwark Webmail! This document provides guidelines and information for contributors.

## Getting Started

### Development Setup

1. **Fork and clone** the repository:

   ```bash
   git clone https://github.com/bulwarkmail/webmail.git
   cd webmail
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

3. **Set up environment**:

   ```bash
   cp .env.example .env.local
   # Edit .env.local with your JMAP server URL
   ```

4. **Start development server**:
   ```bash
   npm run dev
   ```

### Code Quality

Before submitting a pull request, ensure your code passes all checks:

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Fix lint issues automatically
npm run lint:fix
```

These checks run automatically on commit via Husky pre-commit hooks.

## Code Style Guidelines

### TypeScript

- Use TypeScript for all new code
- Define proper types and interfaces
- Avoid `any` types when possible
- Use meaningful variable and function names

### React Components

- Use functional components with hooks
- Keep components focused and single-purpose
- Extract reusable logic into custom hooks
- Place components in appropriate directories under `/components`

### Styling

- Use Tailwind CSS utility classes
- Follow the existing design system
- Support both dark and light themes
- Use CSS variables for theme colors

## Internationalization (i18n)

This project uses **next-intl** for internationalization. Please follow these guidelines:

### Key Rules

1. **Never hardcode user-facing text** - Always use translations:

   ```tsx
   const t = useTranslations("namespace");
   return <div>{t("key")}</div>;
   ```

2. **Translation file locations**:
   - English: `/locales/en/common.json`
   - French: `/locales/fr/common.json`

3. **Namespace organization**:
   - `login.*` - Login page strings
   - `sidebar.*` - Sidebar navigation
   - `email_list.*` - Email list component
   - `email_viewer.*` - Email viewer component
   - `email_composer.*` - Email composer
   - `common.*` - Shared strings
   - `notifications.*` - Toast/alert messages
   - `settings.*` - Settings page

4. **Adding new strings**:
   - Add to **both** English and French translation files
   - Use descriptive, hierarchical keys
   - Keep translations consistent in tone

5. **Locale-aware navigation**:
   ```tsx
   router.push(`/${params.locale}/settings`);
   ```

## Pull Request Process

### Before Submitting

1. **Create a feature branch**:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the code style guidelines

3. **Test your changes** thoroughly

4. **Update translations** if you added user-facing text

5. **Run all checks**:
   ```bash
   npm run typecheck && npm run lint
   ```

### Submitting

1. **Push your branch** to your fork

2. **Open a Pull Request** with:
   - Clear title describing the change
   - Description of what was changed and why
   - Screenshots for UI changes
   - Reference to any related issues

### Commit Message Convention

Follow the conventional commits format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

Examples:

```
feat: add email threading support
fix: resolve attachment download issue
docs: update README with keyboard shortcuts
```

## Project Structure

```
webmail/
├── app/                    # Next.js App Router pages
│   └── [locale]/          # Locale-aware routing
├── components/            # React components
│   ├── email/            # Email-related components
│   ├── layout/           # Layout components
│   ├── settings/         # Settings components
│   └── ui/               # Reusable UI components
├── contexts/             # React contexts
├── hooks/                # Custom React hooks
├── lib/                  # Utilities and libraries
│   └── jmap/            # JMAP client implementation
├── locales/              # Translation files
│   ├── en/              # English translations
│   └── fr/              # French translations
└── stores/               # Zustand state stores
```

## Security

- **Never commit sensitive data** (API keys, passwords, etc.)
- **Sanitize user input** and email content
- **Block external content** by default for privacy
- Report security vulnerabilities privately (e.g. bulwark@rbm.systems)

## Questions?

If you have questions about contributing, feel free to:

- Open an issue for discussion
- Check existing issues and pull requests

Thank you for helping improve Bulwark Webmail!
