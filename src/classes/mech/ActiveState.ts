/* eslint-disable @typescript-eslint/indent */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// defines the pilot's relationship to the mech for actvive mode. does not hold active mech info (eg heat, destroyed status)
// but associated logic should be handled by this class (eg. ride-along conditions)

import { store } from '@/store'
import { Mech, Deployable, Pilot, MechEquipment, MechWeapon, Mount, ActivationType } from '@/class'
import { Action } from '@/interface'
import { IDeployableData } from '../Deployable'
import { mission } from '@/io/Generators'

enum Stage {
  Narrative = 'Narrative',
  Combat = 'Combat',
  Rest = 'Rest',
}

interface ICombatLogData {
  id: string
  timestamp: string
  mission: number
  encounter: number
  round: number
  event: string
  detail: string
}

interface ICombatStats {
  moves: number
  kills: number
  damage: number
  hp_damage: number
  structure_damage: number
  overshield: number
  heat_damage: number
  reactor_damage: number
  overcharge_uses: number
  core_uses: number
}

interface IActiveStateData {
  stage: string
  mission: number
  turn: number
  actions: number
  overwatch: boolean
  braced: boolean
  overcharged: boolean
  prepare: boolean
  bracedCooldown: boolean
  redundant: boolean
  history: IHistoryItem[]
  mounted: boolean
  stats: ICombatStats
}

class ActiveState {
  private _deployed: Deployable[]
  public _stage: Stage

  private _log: ICombatLogData[] // write this to a pilot log after mission is ended

  private _pilot_mounted: boolean
  private _pilot_move: number

  private _pilot_status: string //enum?

  private _pilot: Pilot
  private _mech: Mech | null

  private _round: number
  private _encounter: number
  private _mission: number

  private _actions: number

  private _barrageSelections: MechWeapon[]
  private _barrageMounts: Mount[]
  private _shBarrageSelection: MechWeapon
  private _shBarrageMount: Mount

  private _self_destruct_counter: number

  private _stabilizeUndo: {
    heat: number
    hp: number
    reloads: string[]
    burn: number
    exposed: boolean
  }
  private _overchargeUndo: string[]
  private _shutDownUndo: {
    heat: number
    cascade: string[]
    statuses: string[]
    conditions: string[]
  }

  private _jockeying: boolean
  private _overwatch: boolean
  private _braced: boolean
  private _overcharged: boolean
  private _prepare: boolean
  private _bracedCooldown: boolean
  private _redundant: boolean
  private _history: IHistoryItem[]
  private _stats: ICombatStats

  public constructor(pilot: Pilot) {
    this._pilot = pilot
    this._mech = null
    this._stage = Stage.Narrative
    this._self_destruct_counter = -1
    this._round = 1
    this._encounter = 1
    this._pilot_move = pilot.Speed
    this._actions = 2
    this._barrageSelections = []
    this._barrageMounts = []
    this._overwatch = false
    this._braced = false
    this._overcharged = false
    this._prepare = false
    this._bracedCooldown = false
    this._redundant = false
    this._history = []
    this._log = []
    this._stats = ActiveState.NewCombatStats()
  }

  public static NewCombatStats(): ICombatStats {
    return {
      moves: 0,
      kills: 0,
      damage: 0,
      hp_damage: 0,
      structure_damage: 0,
      overshield: 0,
      heat_damage: 0,
      reactor_damage: 0,
      overcharge_uses: 0,
      core_uses: 0,
    }
  }

  private save(): void {
    store.dispatch('saveData')
  }

  public get Stats(): ICombatStats {
    return this._stats
  }

  public get Move(): number {
    if (this._pilot_mounted && this._mech.IsShutDown) return 0
    return !this._pilot_mounted ? this._pilot_move : this._mech.CurrentMove
  }

  public get MaxMove(): number {
    if (this._pilot_mounted && this._mech.IsShutDown) return 0
    return !this._pilot_mounted ? this._pilot.Speed : this._mech.Speed
  }

  public get Actions(): number {
    return this._actions
  }

  public set Actions(val: number) {
    this._actions = val
  }

  public get IsProtocolAvailable(): boolean {
    return this.Move === this.MaxMove && this.Actions === 2 && !this._overcharged
  }

  public get IsJockeying(): boolean {
    return this._jockeying
  }

  public set IsJockeying(val: boolean) {
    this._jockeying = val
  }

  public get IsBraceCooldown(): boolean {
    return this._bracedCooldown
  }

  public get SelfDestructCounter(): number {
    return this._self_destruct_counter
  }

  public StartSelfDestruct(): void {
    this._self_destruct_counter = 3
  }

  public CancelSelfDestruct(): void {
    this._self_destruct_counter = -1
  }

  public SelfDestruct(): void {
    this._mech.CurrentHP = 0
    this._mech.CurrentStructure = 0
    this._mech.CurrentStress = 0
    this._mech.Destroyed = true
    this._mech.ReactorDestroyed = true
    this._self_destruct_counter = 0
    if (this._pilot_mounted) this._mech.Pilot.Kill()
  }

  public get Stage(): Stage {
    return this._stage
  }

  public get Encounter(): number {
    return this._encounter
  }

  public get Mission(): number {
    return this._mission
  }

  public get Round(): number {
    return this._round
  }

  public StartCombat(): void {
    this._stage = Stage.Combat
    this._pilot_mounted = true
    this._round = 0
    this._encounter++
    this.SetLog({
      id: 'start_combat',
      event: 'LOG.INIT',
      detail: 'COMBAT MODE ACTIVATED',
    })
    this.NextRound()
    this.save()
  }

  public NextRound(): void {
    this._round++
    if (this.SelfDestructCounter > 0) this._self_destruct_counter -= 1
    if (this.SelfDestructCounter === 0) this.SelfDestruct()
    if (this._bracedCooldown) this._bracedCooldown = false
    if (this._braced) this._braced = true
    this._actions = this._braced ? 1 : 2
    this._pilot_move = this._pilot.Speed
    this._barrageSelections = []
    this._barrageMounts = []
    // TODO: base on freq
    this.AllActions.forEach(a => a.Reset())
    this.AllBaseTechActions.forEach(a => a.Reset())
    this._mech.ActiveLoadout.Equipment.forEach(e => e.Reset())
    this._mech.Pilot.Loadout.Equipment.forEach(e => e.Reset())
    this._mech.CurrentMove = this._braced ? 0 : this._mech.MaxMove
    this._braced = false
    this.SetLog({
      id: 'start_combat',
      event: 'LOG.ROUND',
      detail: 'ROUND START',
    })
    this.save()
  }

  public StartRest(): void {
    this._stage = Stage.Rest
    this._pilot.CurrentHP += Math.ceil(this._pilot.MaxHP / 2)
    this._mech.CurrentHeat = 0
    this._mech.Conditions.splice(0, this._mech.Conditions.length)
    this._mech.Statuses.splice(0, this._mech.Statuses.length)
    if (this._mech.Pilot.IsDownAndOut)
      this._mech.Pilot.CurrentHP = Math.ceil(this._mech.Pilot.MaxHP / 2)
    this.SetLog({
      id: 'start_combat',
      event: 'LOG.END',
      detail: 'ENCOUNTER COMPLETE. COMBAT MODE DEACTIVATED.',
    })
    this.save()
  }

  public StartMission(): void {
    this._mission += 1
    this._stats = ActiveState.NewCombatStats()
    this.SetLog({
      id: 'start_mission',
      event: 'MISSION.START',
      detail: `STARTING MISSION//${this.timestamp}::${mission()}`,
    })
    this.StartCombat()
  }

  public EndMission(): void {
    this._pilot.UpdateCombatStats(this._stats)
    this.SetLog({
      id: 'end_mission',
      event: 'MISSION.COMPLETE',
      detail: `REC::MISSION COMPLETE @ ${this.timestamp}`,
    })
    this._stage = Stage.Narrative
    this.save()
  }

  RepairHP(): void {
    this._mech.CurrentHP = this._mech.MaxHP
    this._mech.CurrentRepairs -= 1
  }

  RepairStructure(): void {
    this._mech.CurrentStructure += 1
    const cheap = this._mech.Bonuses.find(x => x.ID === 'cheap-struct')
    this._mech.CurrentRepairs -= cheap ? 1 : 2
  }

  RepairStress(): void {
    this._mech.CurrentStress = this._mech.MaxStress
    const cheap = this._mech.Bonuses.find(x => x.ID === 'cheap-stress')
    this._mech.CurrentRepairs -= cheap ? 1 : 2
  }

  RepairSystem(w: MechEquipment): void {
    w.Repair()
    this._mech.CurrentRepairs -= 1
  }

  RepairDestroyed(selfRepairPts: number): void {
    this._mech.CurrentRepairs -= selfRepairPts
    this._mech.Repair()
  }

  public set ActiveMech(mech: Mech | null) {
    this._mech = mech
    this.save()
  }

  public get ActiveMech(): Mech | null {
    return this._mech || null
  }

  public get IsMounted() {
    return this._pilot_mounted
  }

  public set IsMounted(val: boolean) {
    this._pilot_mounted = val
    this.save()
  }

  // -- Barrage Staging ---------------------------------------------------------------------------

  public get BarrageSelections(): MechWeapon[] {
    return this._barrageSelections
  }

  public get SHBarrageSelection(): MechWeapon {
    return this._shBarrageSelection
  }

  public get BarrageMounts(): Mount[] {
    return this._barrageMounts
  }

  public get SHBarrageMount(): Mount {
    return this._shBarrageMount
  }

  public SelectShBarrage(w: MechWeapon, m: Mount) {
    this._shBarrageSelection = w
    this._shBarrageMount = m
  }

  public ClearShBarrage() {
    this._shBarrageSelection = null
    this._shBarrageMount = null
  }

  public SelectBarrage(w: MechWeapon, m: Mount) {
    if (this._barrageSelections.length < 2) this._barrageSelections.push(w)
    if (this._barrageMounts.length < 2) this._barrageMounts.push(m)
  }

  public RemoveBarrage(w: MechWeapon, m: Mount) {
    const idx = this._barrageSelections.findIndex(x => x.ID === w.ID)
    if (idx > -1) this._barrageSelections.splice(idx, 1)
    const midx = this._barrageMounts.findIndex(x => x.ID === m.ID)
    if (midx > -1) this._barrageMounts.splice(idx, 1)
  }

  public ClearBarrageSelections() {
    this._barrageSelections = []
    this._barrageMounts = []
  }

  // -- Actions -----------------------------------------------------------------------------------
  private get timestamp(): string {
    const d = new Date()
    return `${d.getFullYear() + 3000}.${d.getMonth() + 1}.${d
      .getDate()
      .toString()
      .padStart(2, '0')}//${d
      .getHours()
      .toString()
      .padStart(2, '0')}:${d
      .getMinutes()
      .toString()
      .padStart(2, '0')}:${d
      .getMilliseconds()
      .toString()
      .padStart(2, '0')}`
  }

  public SetLog(entry: { id: string; event: string; detail: string }) {
    this._log.push({
      id: entry.id,
      timestamp: this.timestamp,
      encounter: this._encounter,
      mission: this._mission,
      round: this._round,
      event: entry.event,
      detail: entry.detail,
    })
  }

  public CommitAction(action: Action, free?: boolean) {
    let activationCost = 0
    if (!free) {
      if (action.Activation === ActivationType.Quick) activationCost = 1
      else if (action.Activation === ActivationType.Full) activationCost = 2
    }

    if (this.Actions >= activationCost) {
      action.Use()
      this.Actions -= activationCost
      if (action.HeatCost) this._mech.CurrentHeat += action.HeatCost
      this.SetLog({
        id: action.LogID,
        event: action.Activation.toUpperCase(),
        detail: action.Log ? action.Log : action.Name.toUpperCase(),
      })
    }

    if (action.ID === 'act_jockey') this.IsJockeying = true
    else this.IsJockeying = false
    if (action.ID === 'act_self_destruct') this.StartSelfDestruct()
    if (action.ID === 'act_shut_down') this.CommitShutDown()
    if (action.ID === 'act_boot_up') this.CommitBootUp()
    if (action.ID === 'act_brace') this._braced = true
    if (action.ID === 'act_dismount') this._pilot_mounted = false
    if (action.ID === 'act_mount') this._pilot_mounted = true
    if (action.ID === 'act_hide') this._mech.AddStatus('HIDDEN')
    if (action.ID === 'act_eject') {
      this._mech.AddCondition('IMPAIRED')
      this._pilot_mounted = false
    }
  }

  public UndoAction(action: Action) {
    if (action.LastUse === ActivationType.Quick) this.Actions += 1
    else if (action.LastUse === ActivationType.Full) this.Actions += 2

    action.Undo()

    if (action.HeatCost) this._mech.CurrentHeat -= action.HeatCost

    const idx = this._log.map(x => x.id === action.LogID).lastIndexOf(true)
    if (idx > -1) this._log.splice(idx, 1)

    if (action.ID === 'act_jockey') this.IsJockeying = false
    if (action.ID === 'act_self_destruct') this.CancelSelfDestruct()
    if (action.ID === 'act_shut_down') this.UndoShutDown()
    if (action.ID === 'act_boot_up') this.UndoBootUp()
    if (action.ID === 'act_brace') this._braced = false
    if (action.ID === 'act_dismount') this._pilot_mounted = true
    if (action.ID === 'act_mount') this._pilot_mounted = false
    if (action.ID === 'act_hide') this._mech.RemoveStatus('HIDDEN')
    if (action.ID === 'act_eject') {
      this._mech.RemoveCondition('IMPAIRED')
      this._pilot_mounted = false
    }
  }

  public SetMove(val: number) {
    this._stats.moves += this._mech.CurrentMove - val
    this._mech.CurrentMove = val
    this.SetLog({
      id: `set_move`,
      event: 'MOVE',
      detail: `${
        val > 0 ? `FRAME/COMMIT.TAC: ${val} SPACES` : `FRAME/RESCIND.TAC: ${Math.abs(val)} SPACES`
      }`,
    })
  }

  public SetStatusCondition(statuses: string[], isStatus?: boolean) {
    const scType = isStatus ? 'Statuses' : 'Conditions'
    if (!statuses.length) {
      this._mech[scType] = statuses
      this.SetLog({
        id: `clear_status`,
        event: 'STATUS',
        detail: `FRAME/STATUS.CLEAR ++ALARM.OFF.ALL++`,
      })
      return
    }
    const added = statuses.find(x => !this._mech[scType].includes(x))
    const removed = this._mech[scType].find(x => !statuses.includes(x))
    const sstr = added ? added : removed
    this._mech[scType] = statuses
    this.SetLog({
      id: `set_status`,
      event: 'STATUS',
      detail: `${added ? '' : '!ALERT! '}FRAME/STATUS.${sstr.toUpperCase()} ++ALARM.${
        removed ? 'OFF' : 'ON'
      }++`,
    })
  }

  public SetResistance(resistances: string[]) {
    if (!resistances.length) {
      this._mech.Resistances = resistances
      this.SetLog({
        id: `clear_resist`,
        event: 'RESISTANCE',
        detail: `FRAME/DEF.RES ++RES.END.ALL++`,
      })
      return
    }
    const added = resistances.find(x => !this._mech.Resistances.includes(x))
    const removed = this._mech.Resistances.find(x => !resistances.includes(x))
    const sstr = added ? added : removed
    this._mech.Resistances = resistances
    this.SetLog({
      id: `set_res`,
      event: 'RESISTANCE',
      detail: `FRAME/DEF.RES::${sstr.toUpperCase()}${removed ? '++RES.END++' : ''}`,
    })
  }

  public SetBurn(val: number) {
    this._mech.Burn = val
    this.SetLog({
      id: `set_burn`,
      event: 'BURN',
      detail: `${
        val > 0
          ? `!ALERT! FRAME/DMG.ONGOING: ${val} ++ALARM.ON++`
          : `FRAME/DMG.MITIGATE: ${Math.abs(val)} ${
              this._mech.Burn > 0 ? '++ALARM.ON++' : '++ALARM.OFF++'
            }`
      }`,
    })
  }

  public CommitFullRepair() {
    this._mech.FullRepair()
    this.SetLog({
      id: `full_repair`,
      event: 'FULL REPAIR',
      detail: `FRAME/ROOT::FULL REPAIR`,
    })
  }

  public SetStructure(val: number) {
    this._stats.structure_damage += this._mech.CurrentStructure - val
    this._mech.CurrentStructure = val
    const pct = (this._mech.CurrentStructure / this._mech.MaxStructure).toFixed(2)
    this.SetLog({
      id: `set_str`,
      event: 'STRUCTURE DAMAGE',
      detail: `!CRITICAL! FRAME.STR::INTEGRITY COMPROMISED ++${pct}++`,
    })
  }

  public SetStress(val: number) {
    this._stats.reactor_damage += this._mech.CurrentStress - val
    this._mech.CurrentStress = val
    const pct = (this._mech.CurrentStress / this._mech.MaxStress).toFixed(2)
    this.SetLog({
      id: `set_stress`,
      event: 'REACTOR STRESS',
      detail: `!CRITICAL! FRAME.REACTOR::INTEGRITY COMPROMISED ++${pct}++`,
    })
  }

  public SetOvershield(val: number) {
    this._stats.overshield += this._mech.Overshield - val
    this._mech.Overshield = val
    this.SetLog({
      id: `set_overshield`,
      event: 'OVERSHIELD',
      detail: `FRAME.REMOTE::OVERSHIELD.SET ++${val}++`,
    })
  }

  public SetHp(val: number) {
    this._stats.hp_damage += this._mech.CurrentHP - val
    if (val > this._mech.CurrentHP) {
      this._mech.CurrentHP = val
      this.SetLog({
        id: `rep_dmg`,
        event: 'REPAIR',
        detail: `FRAME/REP.PROCESS:: ${val} HP RESTORED`,
      })
    } else {
      const str = this._mech.CurrentStructure
      this._mech.CurrentHP = val
      this.SetLog({
        id: `add_dmg`,
        event: 'DAMAGE',
        detail: `!WARN! INC:: ${val} HP DAMAGE`,
      })
      if (this._mech.CurrentStructure < str) {
        const pct = (this._mech.CurrentStructure / this._mech.MaxStructure).toFixed(2)
        this.SetLog({
          id: `set_str`,
          event: 'STRUCTURE DAMAGE',
          detail: `!CRITICAL! FRAME.STR::INTEGRITY COMPROMISED ++${pct}++`,
        })
      }
    }
  }

  public SetHeat(val: number) {
    this._stats.heat_damage += val
    if (val < this._mech.CurrentHeat) {
      const dz = this._mech.IsInDangerZone
      this._mech.CurrentHeat = val
      this.SetLog({
        id: `clear_heat`,
        event: 'CLEAR HEAT',
        detail: `FRAME/REACTOR.VENT:: ${val} HEAT CLEARED`,
      })
      if (dz && !this._mech.IsInDangerZone) {
        this.SetLog({
          id: `out_dangerzone`,
          event: 'HEAT LEVELS NOMINAL',
          detail: `FRAME/REACTOR:: ++TEMP.OK++`,
        })
      }
    } else {
      const str = this._mech.CurrentStress
      this._mech.CurrentHeat = val
      this.SetLog({
        id: `add_heat`,
        event: 'HEAT',
        detail: `!WARN! FRAME/REACTOR.HEAT_LVL:: ${val} HEAT`,
      })
      if (this._mech.IsInDangerZone) {
        this.SetLog({
          id: `dangerzone`,
          event: 'HEAT ALERT',
          detail: `!ALERT! FRAME/REACTOR:: ++TEMP.CRITICAL++`,
        })
      }
      if (this._mech.CurrentStress < str) {
        const pct = (this._mech.CurrentStress / this._mech.MaxStress).toFixed(2)
        this.SetLog({
          id: `set_stress`,
          event: 'REACTOR STRESS',
          detail: `!CRITICAL! FRAME.REACTOR::INTEGRITY COMPROMISED ++${pct}++`,
        })
      }
    }
  }

  public SetRepCap(val: number) {
    this._mech.CurrentRepairs = val
    this.SetLog({
      id: `set_rep`,
      event: 'REPAIR CAPACITY',
      detail: `${
        val < 0 ? `FRAME/COMMIT.REPAIR: ${val}` : `FRAME/RECOVER.REPAIR: ${Math.abs(val)}`
      }`,
    })
  }

  public SetCorePower(val: number) {
    this._stats.core_uses += this._mech.CurrentCoreEnergy - val
    this._mech.CurrentCoreEnergy = val
    this.SetLog({
      id: `set_core`,
      event: 'CORE POWER',
      detail: `${
        val > 0 ? `FRAME/CORE:: CAPACITY RESTORED` : `!ALERT! FRAME CORE ACTIVATION !ALERT!`
      }`,
    })
  }

  public SetOvercharge(val: number) {
    const inc = this._mech.CurrentOvercharge < val
    this._mech.CurrentOvercharge = val
    this.SetLog({
      id: `set_oc`,
      event: 'OVERCHARGE',
      detail: `${
        inc
          ? `!WARN! FRAME/REACTOR.SYS::POWER REROUTE CONFIRM ++HEAT.ALARM.ON++`
          : `FRAME/REACTOR.SYS::CHARGE PROTOCOL RECOVERY`
      }`,
    })
  }

  public CommitStabilize(major: string, minor: string) {
    this.Actions -= 2
    this._stabilizeUndo = {
      heat: this._mech.CurrentHeat,
      hp: this._mech.CurrentHP,
      reloads: this._mech.ActiveLoadout.Weapons.filter(x => x.IsLoading && !x.Loaded).map(
        w => w.ID
      ),
      burn: this._mech.Burn,
      exposed: this._mech.Statuses.includes('EXPOSED'),
    }
    let str = 'FRAME.ROOT.DEF//STABILIZE'
    if (major === 'cool') {
      str += ' ::REACTOR_VENT'
      this._mech.CurrentHeat = 0
      const expIdx = this._mech.Statuses.indexOf('EXPOSED')
      if (expIdx > -1) this._mech.Statuses.splice(expIdx, 1)
    } else if (major === 'repair') {
      str += ' ::REPAIR'
      this._mech.CurrentRepairs -= 1
      this._mech.CurrentHP = this._mech.MaxHP
    }

    if (minor === 'reload') {
      str += ' ::RELOAD'
      this._mech.ActiveLoadout.Weapons.filter(x => x.IsLoading && !x.Loaded).forEach(
        w => (w.Loaded = true)
      )
    } else if (minor === 'end_burn') {
      str += ' ::END.BURN'
      this._mech.Burn = 0
    } else if (minor === 'end_self_condition') str += ' ::SYS.RESTORE'
    else if (minor === 'end_ally_condition') str += ' ::REMOTE.ASSIST'

    this.SetLog({
      id: `stabilize`,
      event: 'STABILIZE',
      detail: str,
    })
  }

  public UndoStabilize(major: string, minor: string) {
    this.Actions += 2
    const idx = this._log.map(x => x.id === 'stabilize').lastIndexOf(true)
    if (idx > -1) this._log.splice(idx, 1)
    if (major === 'cool') {
      this._mech.CurrentHeat = this._stabilizeUndo.heat
      if (this._stabilizeUndo.exposed) this._mech.Statuses.push('EXPOSED')
    } else if (major === 'repair') {
      this._mech.CurrentRepairs += 1
      this._mech.CurrentHP = this._stabilizeUndo.hp
    }

    if (minor === 'reload') {
      this._stabilizeUndo.reloads.forEach(
        x => (this._mech.ActiveLoadout.Weapons.find(w => w.ID === x).Loaded = false)
      )
    } else if (minor === 'end_burn') {
      this._mech.Burn = this._stabilizeUndo.burn
    }
  }

  public ClearBurn() {
    this._mech.Burn = 0
  }

  public TakeBurn() {
    this._mech.AddDamage(this._mech.Burn)
  }

  public CommitOvercharge(action: Action, heat: number) {
    this._overchargeUndo = []
    this.AllActions.concat(this.TechActions).forEach(a => {
      if (a.Used) this._overchargeUndo.push(a.ID)
      a.Reset()
    })
    this.CommitAction(action)
    this.Actions += 1
    this._mech.AddHeat(heat)
    if (this._mech.CurrentOvercharge < this._mech.OverchargeTrack.length)
      this._mech.CurrentOvercharge += 1
  }

  public UndoOvercharge(action: Action, heat: number) {
    this.AllActions.forEach(a => {
      if (this._overchargeUndo.includes(a.ID)) a.Use()
    })
    this.TechActions.forEach(a => {
      if (this._overchargeUndo.includes(a.ID)) a.Use()
    })
    this.UndoAction(action)
    this._overchargeUndo = []
    this.Actions -= 1
    this._mech.ReduceHeat(heat)
    if (this._mech.CurrentOvercharge > 0) this._mech.CurrentOvercharge -= 1
  }

  public CommitShutDown() {
    this._shutDownUndo = {
      heat: this._mech.CurrentHeat,
      cascade: this._mech.ActiveLoadout.Equipment.filter(x => x.IsCascading).map(e => e.ID),
      statuses: this._mech.Statuses,
      conditions: this._mech.Conditions,
    }
    this._mech.CurrentHeat = 0
    this._mech.RemoveStatus('EXPOSED')
    this._mech.RemoveCondition('JAMMED')
    this._mech.RemoveCondition('LOCK ON')
    this._mech.ActiveLoadout.Equipment.filter(x => x.IsCascading).forEach(e => {
      e.IsCascading = false
    })
    this._mech.AddStatus('SHUT DOWN')
    this._mech.AddStatus('STUNNED')
  }

  public UndoShutDown() {
    this._mech.CurrentHeat = this._shutDownUndo.heat
    this._mech.ActiveLoadout.Equipment.forEach(e => {
      if (this._shutDownUndo.cascade.includes(e.ID)) e.IsCascading = true
    })
    this._mech.Statuses = this._shutDownUndo.statuses
    this._mech.Conditions = this._shutDownUndo.conditions
  }

  public CommitBootUp() {
    this._mech.RemoveStatus('SHUT DOWN')
    this._mech.RemoveCondition('STUNNED')
  }

  public UndoBootUp() {
    this._mech.AddStatus('SHUT DOWN')
    this._mech.AddCondition('STUNNED')
  }

  public LogAttackAction(action: string, weapon: string, damage: number, kill?: boolean) {
    this._stats.damage += damage
    this._stats.kills += kill ? 1 : 0
    this.SetLog({
      id: action,
      event: weapon.toUpperCase(),
      detail: `${action.toUpperCase()}//${weapon.toUpperCase()}::${damage} DMG ${
        kill ? '++KILL CONFIRM++' : ''
      }`,
    })
  }

  public UndoLogAttackAction(action: string, weapon: string, damage: number, kill?: boolean) {
    this._stats.damage -= damage
    this._stats.kills -= kill ? 1 : 0
    const idx = this._log
      .map(x => x.id === action && x.event === weapon.toUpperCase())
      .lastIndexOf(true)
    if (idx > -1) this._log.splice(idx, 1)
  }

  public Deploy(d: IDeployableData) {
    const n = this._deployed.filter(x => x.BaseName.toLowerCase().includes(d.name.toLowerCase()))
      .length
    this._deployed.push(new Deployable(d, this._mech, n))
    this.SetLog({
      id: `deploy`,
      event: 'DEPLOY EQUIPMENT',
      detail: `FRAME/REMOTE::${d.name.toUpperCase().replace(/\s/g, '.')}.${n} ++STATUS OK++`,
    })
  }

  // -- Action Collection -------------------------------------------------------------------------

  private get baseActions(): Action[] {
    return store.getters.getItemCollection('Actions').filter(x => x)
  }

  public BaseActions(type: string): Action[] {
    return this.baseActions.filter(x => x.Activation === type)
  }

  public ItemActions(type: string): Action[] {
    return this._mech.Actions.filter(x => x.Activation === type)
  }

  public ActionsByType(type: string): Action[] {
    return this.BaseActions(type).concat(this.ItemActions(type))
  }

  private get baseActionTypes() {
    const exclude = ['Move', 'Invade', 'Quick Tech', 'Full Tech']
    return Object.keys(ActivationType)
      .map(k => ActivationType[k as string])
      .filter(x => !exclude.includes(x))
  }

  private get techActionTypes() {
    const include = ['Invade', 'Quick Tech', 'Full Tech']
    return Object.keys(ActivationType)
      .map(k => ActivationType[k as string])
      .filter(x => include.includes(x))
  }

  public get AllBaseActions(): Action[] {
    return this.baseActionTypes.flatMap(t => this.BaseActions(t))
  }

  public get AllBaseTechActions(): Action[] {
    return this.techActionTypes.flatMap(t => this.BaseActions(t))
  }

  public get AllItemActions(): Action[] {
    return this.baseActionTypes.flatMap(t => this.ItemActions(t))
  }

  public get AllItemTechActions(): Action[] {
    return this.techActionTypes.flatMap(t => this.ItemActions(t))
  }

  public get AllActions(): Action[] {
    return this.AllBaseActions.concat(this.AllItemActions)
  }

  public get AvailableActions(): string[] {
    if (!this.IsMounted) {
      return this.AllActions.filter(x => x.IsPilotAction && !x.IsActiveHidden).map(x => x.ID)
    } else {
      if (this._mech.IsShutDown) {
        return ['act_boot_up', 'act_dismount', 'act_eject']
      }
      if (this._mech.IsStunned) {
        return ['act_dismount', 'act_eject']
      }
      return this.AllActions.filter(x => x.IsMechAction && !x.IsActiveHidden).map(x => x.ID)
    }
  }

  public get TechActions(): Action[] {
    const exclude = ['QUICK TECH', 'FULL TECH']
    const out = this.AllBaseTechActions.concat(this.AllItemTechActions)
    return out.filter(x => !exclude.some(y => y === x.Name.toUpperCase()))
  }

  // -- Log ---------------------------------------------------------------------------------------
  public get Log() {
    return this._log
  }

  // -- I/O ---------------------------------------------------------------------------------------

  public static Serialize(s: ActiveState): IActiveStateData {
    return {
      stage: s._stage,
      turn: s._round,
      mission: s._mission,
      // move: s.Move,
      actions: s._actions,
      overwatch: s._overwatch,
      braced: s._braced,
      overcharged: s._overcharged,
      prepare: s._prepare,
      bracedCooldown: s._bracedCooldown,
      redundant: s._redundant,
      history: s._history,
      mounted: s._pilot_mounted,
      stats: s._stats,
    }
  }

  public static Deserialize(pilot: Pilot, data: IActiveStateData): ActiveState {
    const s = new ActiveState(pilot)
    s._stage = (data.stage as Stage) || Stage.Narrative
    s._round = data.turn || 1
    s._mission = data.mission || 0
    s._actions = data.actions || 2
    s._overwatch = data.overwatch || false
    s._braced = data.braced
    s._overcharged = data.overcharged
    s._prepare = data.prepare
    s._bracedCooldown = data.bracedCooldown
    s._redundant = data.redundant
    s._history = data.history
    s._pilot_mounted = data.mounted
    s._stats = data.stats ? data.stats : ActiveState.NewCombatStats()
    return s
  }
}

export { ActiveState, IActiveStateData, ICombatStats }
