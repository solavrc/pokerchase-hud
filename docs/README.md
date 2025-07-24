# PokerChase HUD Documentation

This directory contains detailed technical documentation for the PokerChase HUD Chrome extension.

## 📁 Documentation Structure

### Architecture Decision Records (`adr/`)
Key architectural decisions and their rationale:
- [ADR-001: Data Storage Architecture](adr/001-data-storage-architecture.md) - Dexie.js, normalized entities, Firestore strategy
- [ADR-002: Database Index Optimization](adr/002-database-index-optimization.md) - v3 migration with composite indexes

### Implementation Details (`implementation/`)
Detailed technical implementation guides:
- [File Organization](implementation/file-organization.md) - Complete directory structure and file descriptions
- [Firebase Setup](implementation/firebase-setup.md) - Firebase integration and cloud sync setup guide

### Reference Documentation (`reference/`)
API and technical references:
- [API Events Reference](reference/api-events.md) - Complete WebSocket API event documentation

## 🔗 Quick Links

### Main Documentation
- [CLAUDE.md](../CLAUDE.md) - AI agent instructions and architecture overview
- [README.md](../README.md) - Project overview and quick start
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Contribution guidelines and development setup

### Code References
- API Types: `src/types/api.ts`
- Database Schema: `src/db/poker-chase-db.ts`
- Stream Processing: `src/streams/`
- Statistics: `src/stats/`

## 📝 Documentation Guidelines

1. **Architecture Decisions**: Document significant technical decisions in ADRs
2. **Implementation Details**: Keep detailed setup instructions separate from main docs
3. **Code References**: Prefer linking to source code over duplicating information
4. **Updates**: Keep documentation synchronized with code changes