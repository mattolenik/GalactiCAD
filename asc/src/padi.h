//
// padi.h
//
// Header of padi.cpp
//
// Tien-Tsin Wong 1996
//
#ifndef __PADI_H
#define __PADI_H

#include "datatype.h"
#include "common.h"

// Label of sides of a padi
#define RIGHT   0      //      1
#define TOP     1      //   +----+
#define LEFT    2      // 2 |    | 0
#define BOTTOM  3      //   +----+
                       //      3

#define SIDETONAME(a,s) { \
                          switch (a) \
                          { \
                            case RIGHT: strcpy(s, "RIGHT");  break; \
                            case TOP:   strcpy(s, "TOP");    break; \
                            case LEFT:  strcpy(s, "LEFT");   break; \
                            case BOTTOM:strcpy(s, "BOTTOM"); break; \
                          } \
                        }

class Padi
{
  private:
    CHAR lignavail;  // indicate whether lign info is avialable
    CHAR occ[4];
    Lign *lign[4];
#ifdef PLANTOUT
    CHAR forward[4];
    CHAR backward[4];
    int fixidx;  // Since the plantout algorithm get bugs in 2 out of 16 cases
                 // this index is used to fix the problem
#else
    UCHAR lookupidx;
    static CHAR *edgetable[256];  // actually 15 entries are enough
                                  // the reason to use 256 entries is due to
                                  // the scheme of constructing the index
#endif

  public:
    SIMPLEDT dike[4];
    Padi *next, *previous;   // hold padi in a doubly linked list

  private:
    void GetCrossPt(int side, float &x, float &y, float &spacing);
    void ResolveAmbiguity(SIMPLEDT xdike, SIMPLEDT ydike, Farm *farm, Block *block);

  public:
#ifdef PLANTOUT
    Padi(){ lignavail=FALSE; next=NULL; previous=NULL; lign[0]=lign[1]=lign[2]=lign[3]=NULL;};
#else
    Padi(){ lignavail=FALSE; next=NULL; previous=NULL;
            lign[0]=lign[1]=lign[2]=lign[3]=NULL; };
#endif
    ~Padi(){};
    void Init(SIMPLEDT xdike, SIMPLEDT ydike, Farm *farm, Block *block);
    int EnclosedByQ(Padi *encloser);  // test whether the given padi enclose this
    int OverlapQ(Padi *padi); // test whether the input padi overlap this
    void ClipBy(Padi *clipper, Padi **holder, int &cnt, Farm *farm=NULL, Block *block=NULL); // clip this padi by clipper
    void Draw2D(float spacing, float offset);
    void PlantOut();
    void GenEdge(CHAR *edgearr, int &cnt);

  friend class DoublyList;
  friend class Farm;
  friend void PadiInitEdgeTable();
};


void Out2DPadiPS(VOXELDT *data1, Farm *farm, int offx, int offy, int offz,
                 int datadimx, int datadimy, int datadimz);
void PadiInitEdgeTable();   // init the edge generation table for padi


#endif
